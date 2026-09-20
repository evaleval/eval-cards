## Multi-stage Dockerfile for Next.js app (suitable for Hugging Face Spaces Docker runtime)
# - Builder stage installs deps and builds the Next app
# - Runner stage copies build artifacts and runs `npm run start` on $PORT (default 3000)

FROM node:24-bookworm-slim AS builder
WORKDIR /app

ARG PNPM_VERSION=10.25.0

# Build-time data-source configuration. HF Spaces "Variables" are NOT injected
# into Docker RUN steps automatically — only into the final runtime — so we
# bake the selected backend here. `DATA_BACKEND=v2` reads `SNAPSHOT_URL`
# directly; legacy DuckDB mode still clones `HF_DATASET_REPO` into the cache.
# Override at build time via `--build-arg ...`.
ARG DATA_BACKEND=v2
ARG HF_DATASET_REPO=https://huggingface.co/datasets/evaleval/card_backend
# SNAPSHOT_URL is resolved at build time (see the build step below): pass an
# explicit `--build-arg SNAPSHOT_URL=...` to pin a snapshot; leave it empty to
# default to the latest published one. The resolved value is baked for runtime
# so prerendered pages and live queries read the same snapshot.
ARG SNAPSHOT_URL=
# Static prerender (`next build`) executes route handlers against SNAPSHOT_URL.
ENV DATA_BACKEND=${DATA_BACKEND} \
    HF_DATASET_REPO=${HF_DATASET_REPO} \
    LOCAL_PIPELINE_OUTPUT=/app/.cache/hf-data \
    HF_DATA_LOCAL_DIR=/app/.cache/hf-data \
    HF_DATA_OFFLINE=1

# install OS build deps required by some native node modules and package manager
# copy lockfile first to leverage Docker layer caching
COPY package*.json ./
COPY pnpm-lock.yaml ./

# Install minimal build tools for native modules (node-gyp) and install pnpm.
# Using the repo's `pnpm-lock.yaml` keeps installs deterministic on Spaces.
ENV DEBIAN_FRONTEND=noninteractive \
	CI=true
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates python3 build-essential git curl \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install -g pnpm@${PNPM_VERSION} \
	&& pnpm install --frozen-lockfile

# copy source and build
COPY . ./
# Resolve the snapshot once: an explicit SNAPSHOT_URL build-arg wins; otherwise
# fall back to the latest published snapshot. Bake the resolved value to a file
# so the runtime stage serves the exact snapshot we prerendered against. Fails
# the build (test -n) rather than shipping an empty/guessed snapshot.
# Strip whitespace first: a Space "Variable" pasted with a trailing newline
# arrives here verbatim and would otherwise be spliced into every snapshot URL
# (`.../<snapshot>\n/eval_results_view.parquet` -> 404 -> failed build).
RUN set -e; \
    SNAPSHOT_URL="$(printf '%s' "${SNAPSHOT_URL:-}" | tr -d '[:space:]')"; \
    if [ -z "$SNAPSHOT_URL" ]; then SNAPSHOT_URL="$(node scripts/resolve-latest-snapshot.mjs | tr -d '[:space:]')"; fi; \
    test -n "$SNAPSHOT_URL"; \
    printf '%s' "$SNAPSHOT_URL" > /app/.resolved-snapshot-url; \
    echo "[docker] building against snapshot: $SNAPSHOT_URL"; \
    DATA_BACKEND="${DATA_BACKEND}" SNAPSHOT_URL="$SNAPSHOT_URL" pnpm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app

ARG DATA_BACKEND=v2

# Runtime data-source envs (multi-stage doesn't carry ENVs across stages).
# SNAPSHOT_URL is intentionally NOT set here: the entrypoint defaults it to the
# snapshot resolved at build time (.resolved-snapshot-url, copied from the
# builder), and a SNAPSHOT_URL injected by the Space runtime overrides it.
ENV NODE_ENV=production \
    DATA_BACKEND=${DATA_BACKEND} \
    LOCAL_PIPELINE_OUTPUT=/app/.cache/hf-data \
    HF_DATA_LOCAL_DIR=/app/.cache/hf-data \
    HF_DATA_OFFLINE=1

# minimal runtime packages for HTTPS plus HF Spaces dev-mode git setup
RUN apt-get update && apt-get install -y ca-certificates git --no-install-recommends && rm -rf /var/lib/apt/lists/*

# copy runtime artifacts from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/data ./data
COPY --from=builder /app/.cache ./.cache
COPY --from=builder /app/.resolved-snapshot-url ./.resolved-snapshot-url
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/scripts/warm-startup-cache.mjs ./scripts/warm-startup-cache.mjs

# Expose a common port (informational). Hugging Face Spaces will inject $PORT at runtime
# and the CMD below ensures Next listens on that port. Do not hardcode PORT here.
EXPOSE 3000

# If you use private/gated HF models, set HF_TOKEN in the Space secrets and expose here
# e.g. in Space settings: add secret HF_TOKEN with your token

# Ensure `next start` uses the $PORT provided by the Spaces runtime. Start the
# server in the background, warm the high-traffic data endpoints against the
# local instance so `/data/sidecars` and Next route caches are hot, then keep
# the server process in the foreground.
ENTRYPOINT ["sh", "-c", "export SNAPSHOT_URL=\"$(printf '%s' \"${SNAPSHOT_URL:-$(cat /app/.resolved-snapshot-url)}\" | tr -d '[:space:]')\"; echo \"[docker] serving snapshot: $SNAPSHOT_URL\"; npm run start -- -p ${PORT:-3000} & server_pid=$!; node scripts/warm-startup-cache.mjs http://127.0.0.1:${PORT:-3000}; wait $server_pid"]
