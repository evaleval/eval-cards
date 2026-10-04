# Pre-deploy gates

This is the single reference for the "gate" scripts that should be run before this
app deploys: why they exist, exactly what they test, how to run them, and what's
needed to move them into proper CI. It assumes no prior knowledge of the project.

Paths below are relative to the repository root (that's where you run the gates).

## Background: how this app deploys, and why that's risky

This is a Next.js app that reads a data warehouse made of Parquet files, queried
through **DuckDB**. It is deployed as a **HuggingFace Space**. Deployment works by
pushing to a git remote — and **that push builds the app and puts it live
immediately. There is no test, build-check, or review step in between.** Whatever
you push is what users get, within minutes.

DuckDB is reached through a **native binding**, the npm package
`@duckdb/node-api`. "Native" means the package ships compiled machine code, and
**that machine code is different per operating system and CPU.** The binding a
developer runs on **macOS** is a different compiled artifact from the one that
runs on the **Linux** server the HuggingFace Space uses.

Those two artifacts are not perfectly equivalent. When DuckDB returns certain
column types — nested `STRUCT` values, `JSON`, `TIMESTAMP` — and the binding tries
to convert them into plain JavaScript objects, the **Linux build can throw while
the macOS build does not**:

```
Invalid Error: don't know what type: ...
```

So the unit tests pass on a developer's Mac, the code gets pushed, the Space
builds on Linux, and the app crashes for real users on a read path nobody could
have caught locally.

That same `don't know what type:` error has been traced to **two distinct
production causes** (both documented in `lib/duckdb.ts`), which matters for how the
smoke is built:

1. **Binding marshalling** — the macOS-vs-Linux divergence above.
2. **Incoherent mmap'd pages** — production used to mirror the snapshot Parquet to
   a local disk cache (`/data`) and let DuckDB `mmap` it. Right after a fresh
   download, those mapped pages could read back garbage mid-scan even though the
   bytes on disk were byte-for-byte correct (sha256 matched). The fix was to read
   over **httpfs**, which never mmaps a local file.

The smoke deliberately loads its tables over httpfs with **no local `/data`
mmap** — that's why the "over the network, in-memory" detail below is load-bearing,
not incidental: it reproduces cause (1) without re-introducing cause (2).

**That is the core reason these gates exist.** The rule they enforce: *never
deploy code that hasn't been exercised on Linux, the way production reads, using
the exact DuckDB binding version production ships.*

## Why the checks run in Docker

To catch a Linux-only crash you have to actually run the **Linux** build of the
binding. A developer on a Mac cannot do that directly — their machine runs the
macOS build. Docker is how we get a Linux environment on any developer's machine:
the gate does `docker build --platform=linux/amd64`, which produces a Linux
x86-64 container (emulated on Apple-silicon Macs, native on Intel/Linux), installs
`@duckdb/node-api` there, and runs the read paths inside it.

The binding **version** is read out of `pnpm-lock.yaml` and passed into the Docker
build, so the gate always tests the same binding version the app ships and the two
can't drift apart.

**Implication for CI:** a GitHub Actions runner (`ubuntu-latest`) is *already*
Linux x86-64, so in CI you don't strictly need Docker at all — install the pinned
binding and run the scripts directly on the runner. Docker is here only because
it's the way to reproduce Linux *on a developer's Mac*. (See [Moving this to
CI](#moving-this-to-ci).)

## The two gates

Two separate concerns, one gate each.

### 1. Linux read-path smoke — "does it run on Linux at all?"

**Script:** `scripts/linux-gate.sh` → runs `scripts/linux-gate/smoke.mjs` in the
container. **Run it before every push.** Fast once the image is built; the first
run builds the `node:18` image and installs the binding (under amd64 emulation on
Apple silicon), so the first invocation is slower.

Two legs:

1. **Host unit tests** — `pnpm vitest run`, the unit/logic suite on your machine.
2. **Linux DuckDB read-path smoke** — the important one. Inside the Linux
   container, on the pinned binding, it:
   - loads three warehouse "views" (`models_view`, `evals_view`,
     `eval_results_view` — each a Parquet file in the snapshot) into in-memory
     DuckDB tables, **over the network via httpfs** with no local file mmap,
     because that mirrors how the production app opens its connection.
   - runs two queries modelled on the app's real read paths and forces the binding
     to materialise their results into JavaScript via `readAll()` (fetches the
     result chunks) and `getRowObjectsJson()` (the conversion step that crashes on
     a bad type):
     - `SELECT * FROM models_view LIMIT 5` — chosen because `models_view` carries
       the `STRUCT` / `JSON` / `TIMESTAMP` columns that trigger the crash; the bare
       `SELECT *` is a deliberate superset of what the app projects, so every
       column type goes through the marshaller.
     - the leaderboard ranking query (a `RANK()` window over `eval_results_view`,
       `LIMIT 200`).

**Asserts:** the binding can fetch and convert these rows **without throwing**, and
each query returns **more than zero rows**. That's it.

**Does NOT assert:** that the *values* are correct. It's a smoke test — "the read
path executes on Linux," not "the output is right." (That's the other gate's job.)

Exit codes: `0` pass, `1` a read path threw or returned no rows, `2`
misconfigured (e.g. no snapshot URL).

### 2. Leaderboard parity — "does the live query produce the right data?"

**Script:** `scripts/migration-gate.sh` → runs `scripts/linux-gate/parity.mjs`.
**Run on demand**, only when changing how leaderboard data is fetched. Heavier.

The warehouse ships precomputed leaderboard tables, `comparison_metrics.parquet`
and `comparison_scores.parquet`, holding the "correct" leaderboard scores and
rankings from the upstream pipeline (the same rows `comparison-index.json` carries).
The app is being migrated to compute those leaderboards *itself* at runtime with a
DuckDB query instead of reading the precomputed rows. The risk is subtle: the runtime
query could rank, order, or group rows slightly differently and **silently** show
users different numbers.

This gate runs the runtime query on Linux against the live snapshot and compares
its output **row-by-row against the comparison tables**: membership, ordering,
rank, totals, scores (to a 1e-9 tolerance), and the grouping identity. It passes
**only if they match exactly**, and prints a per-category diff
(`length / order / rank / total / score / familyId`) with samples when they don't.

One detail a maintainer will hit: the column holding the grouping key differs
between snapshot versions (`model_family_id` vs `model_group_id`), so the script
inspects the schema with `DESCRIBE` and adapts. If a regenerated snapshot changes
the schema again, that detection is the place to look.

**Lifecycle note:** this gate is *temporary by design*. It diffs against the
producer's comparison tables. If those are ever dropped, convert this into a
**golden-fixture test** (freeze a known-good output and diff against that). Don't
bake in the assumption that they exist forever.

## Running them

From the repository root:

```bash
scripts/linux-gate.sh        # fast: host unit tests + Linux read-path smoke
scripts/migration-gate.sh    # heavier: leaderboard parity, only when touching leaderboard fetch
```

Both require **Docker** and **network access to huggingface.co**: the smoke fetches
snapshot Parquet over DuckDB httpfs (the parity gate also reads the comparison
tables that way).

You do **not** set the DuckDB version — it's read from `pnpm-lock.yaml`.

### Which snapshot the gates test

By default the gates test against the **latest published snapshot**. When
`SNAPSHOT_URL` is unset they call `scripts/resolve-latest-snapshot.mjs`, which
lists `warehouse/` on the HF dataset and picks the newest ISO-timestamped
directory. Pin a specific snapshot by exporting `SNAPSHOT_URL` yourself:

```bash
# default: latest published snapshot, resolved at run time
scripts/linux-gate.sh

# pin a specific snapshot
SNAPSHOT_URL="https://huggingface.co/datasets/evaleval/card_backend/resolve/main/warehouse/<snapshot-id>" \
  scripts/linux-gate.sh
```

The same resolver is the deploy default: the `Dockerfile` resolves the latest
snapshot once at build time (an explicit `--build-arg SNAPSHOT_URL=...` pins it),
bakes it to `.resolved-snapshot-url`, and the runtime entrypoint serves that exact
snapshot unless a `SNAPSHOT_URL` Space variable overrides it. So gate, build, and
runtime all flow from one resolver — no hand-synced literals to drift.

Two caveats worth knowing:

- **Resolution is "newest directory name."** A producer that publishes a snapshot
  dir before its files finish uploading could momentarily look "latest." A
  producer-published `latest` pointer (written only after a complete upload) would
  be more robust; until that exists, pin `SNAPSHOT_URL` if you need certainty.
- **Latest-at-build, not latest-always.** Prod serves whatever was newest at its
  last build; it doesn't auto-advance until the next deploy. The gate, by
  contrast, resolves latest each run — so a gate run can legitimately be a snapshot
  *ahead* of prod. If you want the gate to mirror exactly what prod serves, pin
  both to the same `SNAPSHOT_URL`.

## Optional: run automatically before each push

A committed git hook, `hooks/pre-push`, runs the fast gate and **cancels the push
if it fails.** Git will not enable a repository's own hooks automatically (that
would let a clone run code on you), so it is **off until each person turns it on**,
once per clone:

```bash
git config core.hooksPath hooks
```

Bypass it for a docs-only or emergency push with `SKIP_LINUX_GATE=1 git push`.

A hook only protects the person who enabled it: a fresh clone that skipped the
`git config` step, or any automated push, deploys unchecked. Closing that gap is
exactly what moving to CI does.

## Coverage — grows as tests land

Today the Linux leg is a read-path *smoke* (catches the marshalling-crash class).
As the comparison-index migration proceeds, fold more into the gates:

- the **leaderboard parity** check (already in `migration-gate.sh`),
- **render-equivalence** for the eval page / histogram / DeepDive (a silent-drop
  guard — a data diff can't catch a missing row that renders as an absent bar),
- the **`by_model`-removal consumer** test (slash/percent/dunder identity).

The smoke is the *runner* that makes deploys blockable; these are its *content* —
the full gate is the complete set of checks run through it, not the smoke alone.

## Moving this to CI

**Prerequisite — satisfied.** This repo now lives on GitHub at
[`evaleval/eval-cards`](https://github.com/evaleval/eval-cards), which is the source of
truth; `origin` points there and `space` points at
`https://huggingface.co/spaces/evaleval/general-eval-card`. Pushes to `main` are mirrored
to the Space by `.github/workflows/sync-to-hf-space.yml`, so GitHub Actions is the
authoritative gate while the Space stays the deploy target. Everything below can be
built on that.

With that in place, the gate ports cleanly. Things to preserve and decisions
you'll face:

- **The runner must be Linux x86-64.** `ubuntu-latest` is — so in CI you can **drop
  Docker** and run the scripts directly: install the pinned binding
  (`npm install @duckdb/node-api@<version-from-pnpm-lock>`) and
  `node scripts/linux-gate/smoke.mjs`. Docker only existed to fake Linux on a Mac.
  (Containerising for reproducibility is a choice, not a requirement.)
- **Pin the binding from the lockfile, not by hand** — keep deriving the version
  from `pnpm-lock.yaml` so CI always tests what ships.
- **Give the job network egress to `huggingface.co`** — the scripts fetch the
  snapshot Parquet (httpfs), comparison tables included, at runtime; there's
  no bundled fixture.
- **Decide which snapshot CI tests against** — default is the latest published
  snapshot (`scripts/resolve-latest-snapshot.mjs`); set `SNAPSHOT_URL` on the job
  to pin a specific one for reproducible CI runs.
- **Honour the exit codes** (`0` pass / `1` fail / `2` misconfig) — they drive a CI
  job's pass/fail directly.
- **Treat the parity gate as migration-phase** — convert it to a golden-fixture
  diff if the comparison tables are ever dropped.
- **Keep the pre-push hook as a fast local check if you like** — CI becomes the
  authoritative gate enforced for everyone; the hook stays an optional early
  warning.

A reasonable first migration: one workflow, two jobs — Job A runs
`pnpm install && pnpm vitest run`; Job B installs the pinned binding on
`ubuntu-latest` and runs `smoke.mjs` (and `parity.mjs` when leaderboard-fetch code
changes), with `SNAPSHOT_URL` set **on Job B only** — do not set it on Job A, or
`tests/redirect-integrity.test.ts` (which self-skips unless `SNAPSHOT_URL` is
present) silently switches on and adds a network dependency to the unit job. That
reproduces today's protection for every push, automatically, with no dependence on
anyone enabling a local hook.

One fidelity note: the container pins **Node 18** (`node:18-bullseye-slim`), now
EOL. `@duckdb/node-api` is a Node-API binding and ABI-stable across Node majors, so
a current LTS is fine for CI; matching Node 18 only matters for byte-exact
reproduction of the local gate.

## Where the code is

- `scripts/linux-gate.sh` — fast gate (host tests + Linux smoke).
- `scripts/migration-gate.sh` — leaderboard parity gate.
- `scripts/resolve-latest-snapshot.mjs` — resolves the latest published snapshot
  (the default for the gates and the deploy build).
- `scripts/linux-gate/Dockerfile` — the Linux container the checks run in.
- `scripts/linux-gate/smoke.mjs` — the read-path smoke (what it loads and probes).
- `scripts/linux-gate/parity.mjs` — the parity comparison (the diff logic).
- `hooks/pre-push` — the optional auto-run-before-push hook.
