# How the four signals are computed

*The technical companion to the four interpretive signals. This formalizes how each one is calculated, the fields it depends on, and how it rolls up across the corpus. Adapted from Appendix H.1 of the paper.*

> **See also:** the [Quickstart](/help/quickstart) introduces what each signal means in plain language. This page is the precise definition behind it.

---

## The result triple

Every signal is computed over a **result triple** $r = (m, b, \mu)$:

- $m$: a canonical model identifier,
- $b$: a metric-path through the rollout hierarchy (family → composite → benchmark → split),
- $\mu$: a metric.

$R$ is the set of all such triples in the corpus, and $B$ the set of canonical benchmarks. For any field $f$ and triple $r$:

$$
\mathrm{pop}(f, r) =
\begin{cases}
1 & \text{if } f \text{ is populated in the record for } r, \\
0 & \text{otherwise,}
\end{cases}
$$

and $\mathrm{pop}(f, b)$ is defined analogously for a benchmark $b$ and its Auto-BenchmarkCards record.

## Reproducibility

**In plain terms.** For each result, we check whether its record discloses each of eight setup items needed to re-run the evaluation. Some items apply only to some kinds of run. A result is flagged if any item that applies to it is undisclosed.

**Disclosure.** Let $S_{\mathrm{repro}}$ be the set of eight setup items in the table below. Each item $k$ has a set of fields $F(k)$, and the item is disclosed if any of its fields is populated:

$$
\mathrm{disc}(k, r) = \max_{f \in F(k)} \mathrm{pop}(f, r).
$$

**Applicability.** Three properties of the run decide which items apply:

- whether the run is scored from log-probabilities, read from its scoring mode or stated output type;
- whether the run involves reasoning, for example an affirmative reasoning effort or reasoning-token budget;
- whether the evaluation has an agentic setup, for example an affirmative scaffold, context-compaction setting, agent plan or agent configuration.

When nothing on a result says whether it involved reasoning or an agentic setup, the items that depend on it are left out of the check for that result.

| Setup item | Fields (any one discloses the item) | Applies to |
|---|---|---|
| Decoding | `temperature`, `temperature_raw`, `top_p`, `top_k` | runs not scored from log-probabilities |
| Reasoning budget | `reasoning`, `reasoning_effort`, `effort`, `reasoning_tokens` | reasoning runs |
| Output length | `max_tokens`, `token_limit`, `message_limit`, `max_messages` | runs not scored from log-probabilities |
| Harness | `eval_library.name`, `harness`, `framework`, `lm_eval_task`, `scaffold`, `eval_plan`, `agentic_eval_config` | all runs |
| Harness version | `eval_library.version`, `eval_library_version`, `harness_version`, `lm_eval_task` | all runs |
| Context handling | `compaction`, `context_management`, `truncation` | agentic runs |
| Test set | `split`, `eval_split`, `subset`, `n_tasks`, `n_samples`, `sample_size` | all runs |
| Attempts | `attempts`, `max_attempts`, `epochs`, `num_runs`, `repeats`, `samples`, `n_trajectories` | agentic runs |

**Flag.** Let $A(r) \subseteq S_{\mathrm{repro}}$ be the setup items that apply to result $r$. A result is flagged as a reproducibility gap if an item that applies to it is undisclosed:

$$
G_{\mathrm{repro}}(r) = 1 - \prod_{k \in A(r)} \mathrm{disc}(k, r).
$$

The interface lists the undisclosed items that apply, $\{\, k \in A(r) : \mathrm{disc}(k, r) = 0 \,\}$.

**Corpus level.** Let $\mathcal{T}$ be the set of (model, benchmark, split, metric) tuples with a score. A tuple is flagged if any of its results is flagged, and the corpus rate is the share of flagged tuples. For each item $k$, the reported share is the share of tuples in which some result leaves $k$ undisclosed while $k$ applies:

$$
\bar{G}_{\mathrm{repro}} = \frac{1}{|\mathcal{T}|} \sum_{t \in \mathcal{T}} \max_{r \in t} G_{\mathrm{repro}}(r),
\qquad
\bar{m}(k) = \frac{1}{|\mathcal{T}|} \sum_{t \in \mathcal{T}} \max_{r \in t} \mathbf{1}\bigl[k \in A(r) \text{ and } \mathrm{disc}(k, r) = 0\bigr],\quad k \in S_{\mathrm{repro}}.
$$

## Reporting completeness

**In plain terms.** For each benchmark, we count how many of the 28 schema fields are populated. Present-or-absent fields score 0 or 1; fields that contain sub-items score the fraction of sub-items populated. The completeness score is the average across all 28 fields.

Let $F = \{ f_1, \dots, f_N \}$ be the operationalized schema with $N = 28$ fields, ingested from Auto-BenchmarkCards and EEE plus the reserved Evaluation Cards fields. Each field has a coverage type $\tau(f) \in \{ \text{full}, \text{reserved}, \text{partial} \}$, and the per-field score $s(f, b) \in [0, 1]$ is:

$$
s(f, b) =
\begin{cases}
\mathrm{pop}(f, b) & \text{if } \tau(f) \in \{ \text{full}, \text{reserved} \}, \\[1.2em]
\dfrac{1}{|\mathrm{sub}(f)|} \displaystyle\sum_{f' \in \mathrm{sub}(f)} \mathrm{pop}(f', b) & \text{if } \tau(f) = \text{partial,}
\end{cases}
$$

where $\mathrm{sub}(f)$ is the set of sub-items under a partial-coverage field. For example, a partial field with 4 sub-items, 2 of which are populated, scores $0.5$.

The completeness score for a benchmark is the unweighted mean across fields:

$$
C(b) = \frac{1}{N} \sum_{f \in F} s(f, b) = \frac{1}{28} \sum_{f \in F} s(f, b).
$$

The interface surfaces $C(b)$ alongside the count of fully missing fields, $|\{\, f \in F : s(f, b) = 0 \,\}|$. Across the corpus we report the median per-benchmark completeness, $\mathrm{median}_{b \in B}\, C(b)$, and per-field population rates, $\bar{p}(f) = \frac{1}{|B|} \sum_{b \in B} s(f, b)$.

Completeness and reproducibility are distinct, so a result with no reproducibility gap may still have low completeness.

## Provenance

**In plain terms.** For each reported score, we surface three things: who reported it (first-party, third-party, or collaborative), whether anyone else also reported the same score, and any risk categories associated with the benchmark.

Let $\rho(r) \in \{ \texttt{first\_party}, \texttt{third\_party}, \texttt{collaborative} \}$ be the evaluator relationship for triple $r$. For a triple $(m, b, \mu)$, the set of records reporting it is $R(m, b, \mu) = \{ r \in R : r = (m, b, \mu) \}$.

A score is **first-party-only** if every report comes from the model developer:

$$
\mathrm{FPO}(m, b, \mu) =
\begin{cases}
1 & \text{if } \rho(r) = \texttt{first\_party} \text{ for all } r \in R(m, b, \mu), \\
0 & \text{otherwise.}
\end{cases}
$$

The multi-party indicator is $\mathrm{MP}(m, b, \mu) = 1$ when $|R(m, b, \mu)| > 1$, and $0$ otherwise. Risk annotations are propagated from the Auto-BenchmarkCards risk-mapping component: each benchmark $b$ carries a set of risk categories $K(b)$. These are shown as attention cues in the interface and do **not** enter a numerical score.

## Comparability

**In plain terms.** For each $(m, b, \mu)$ triple with at least two reports, we check whether reported scores differ by more than 5% of the metric's range. We do this two ways: across setups for the same party (variant divergence) and across different parties (cross-party divergence). Either one triggers a flag.

Let $[\mu_{\min}, \mu_{\max}]$ be the metric's native scale and $\theta = 0.05$ the divergence threshold.

**Variant divergence.** For a triple with multiple reported setups (differing in fields such as $\texttt{max\_tokens}$, tool configuration, or agentic scaffolding), let $V(m, b, \mu)$ be the set of distinct variants and $\sigma(v)$ the score under variant $v$. It is flagged when the spread exceeds $\theta$:

$$
D_{\mathrm{var}}(m, b, \mu) =
\begin{cases}
1 & \text{if } \dfrac{\max_v \sigma(v) - \min_v \sigma(v)}{\mu_{\max} - \mu_{\min}} > \theta, \\[1.4em]
0 & \text{otherwise.}
\end{cases}
$$

The differing fields are surfaced as the comparability annotation.

**Cross-party divergence.** Let $P(m, b, \mu) = \{ \rho(r) : r \in R(m, b, \mu) \}$ be the set of reporting parties and $\sigma(p)$ the score reported by party $p$ (averaged across variants within a party if needed). It is flagged when more than one party reports the triple and the spread exceeds $\theta$:

$$
D_{\mathrm{cp}}(m, b, \mu) =
\begin{cases}
1 & \text{if } |P(m, b, \mu)| > 1 \text{ and } \dfrac{\max_p \sigma(p) - \min_p \sigma(p)}{\mu_{\max} - \mu_{\min}} > \theta, \\[1.4em]
0 & \text{otherwise.}
\end{cases}
$$

The underlying setup differences across parties are rendered alongside the divergence.

**Combined flag.** The overall comparability signal is the maximum of the two:

$$
D_{\mathrm{comp}}(m, b, \mu) = \max\big(\, D_{\mathrm{var}}(m, b, \mu),\ D_{\mathrm{cp}}(m, b, \mu) \,\big).
$$

The threshold $\theta = 0.05$ is applied uniformly across metrics; metric-specific thresholds are a candidate extension.

---

## One thing to keep in mind

None of these signals is a grade. Evaluation Cards assigns no letter grades, pass/fail thresholds, or completeness rankings. When a field is omitted, it lowers the completeness score, may trip the reproducibility, provenance, or comparability signals, and is shown to readers directly. The intent is to make reporting choices visible, not to enforce a particular reporting standard.

*Adapted from [Appendix H.1, "Computation of Interpretive Signals"](https://arxiv.org/abs/2606.09809) of the paper.*
