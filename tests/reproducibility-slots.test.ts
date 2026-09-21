import { describe, expect, it } from "vitest"

import {
  evaluateReproducibilitySlots,
  evidenceFromResult,
  type ReproducibilityEvidence,
} from "@/lib/reproducibility-slots"

// Reproducibility is scored per SLOT — one decision a re-runner must pin down,
// satisfiable by any of several fields. The rules that matter:
//   - a knob that does not exist for this run is `n/a`, not a failure
//   - a knob whose applicability we cannot determine is `unknown`, not a failure
//   - neither one is counted in the denominator
// The old fixed temperature+max_tokens checklist violated all three, which is
// why the signal read ~0% across 98% of the corpus.

const state = (summary: ReturnType<typeof evaluateReproducibilitySlots>, id: string) =>
  summary.slots.find((slot) => slot.id === id)?.state

describe("evaluateReproducibilitySlots", () => {
  it("credits a study that discloses its budget under a different field name", () => {
    // The AISI shape: nothing in generation_config, everything in
    // protocol_condition. This scored 0/2 under the old rule.
    const evidence: ReproducibilityEvidence = {
      protocol: {
        compaction: false,
        feedback: "none",
        reasoning_effort: "high",
        reasoning_tokens: 32000,
        scaffold: "S-adaptive",
        token_limit: 10000000,
      },
    }
    const summary = evaluateReproducibilitySlots(evidence)
    // token_limit is disclosed, which settles the slot regardless of mode.
    expect(state(summary, "length")).toBe("disclosed")
    expect(state(summary, "harness")).toBe("disclosed")
    expect(state(summary, "reasoning_budget")).toBe("disclosed")
    // Temperature is not settable on a hosted reasoning run, so the slot does
    // not apply and does not drag the score down.
    expect(state(summary, "decoding")).toBe("not_applicable")
    // The study is agentic (scaffold + compaction) but never says how many
    // times each cell was run, so this one IS a real gap.
    expect(state(summary, "attempts")).toBe("missing")
    // Compaction is context handling, not the harness's identity and not a
    // repeat count.
    expect(state(summary, "context_handling")).toBe("disclosed")
    expect(state(summary, "test_set")).toBe("missing")
    // The study names its scaffold but never pins a version of it.
    expect(state(summary, "harness_pin")).toBe("missing")
    expect(summary.disclosed).toBe(4)
    expect(summary.applicable).toBe(7)
  })

  it("does not treat open weights alone as proof that sampling happened", () => {
    // Open weights say you COULD set temperature, not that this run sampled:
    // a quarter of the corpus is log-prob scored, much of it open-weights
    // models on lm-evaluation-harness. Mode unknown means the slot drops out.
    const summary = evaluateReproducibilitySlots({
      model: { open_weights: true },
      generation_args: { max_tokens: 2048 },
    })
    expect(state(summary, "decoding")).toBe("unknown")
    // max_tokens is disclosed, which settles the length slot by itself.
    expect(state(summary, "length")).toBe("disclosed")
  })

  it("treats temperature 0 as a disclosure, not an absence", () => {
    // The most reproducible answer there is; the old truthiness check dropped it.
    const summary = evaluateReproducibilitySlots({
      model: { open_weights: true },
      generation_args: { temperature: 0 },
    })
    expect(state(summary, "decoding")).toBe("disclosed")
  })

  it("does not let a harness PROPERTY stand in for the harness's identity", () => {
    // "compaction: on" tells you nothing about what you would have to
    // install to re-run this.
    const summary = evaluateReproducibilitySlots({ protocol: { compaction: true } })
    expect(state(summary, "context_handling")).toBe("disclosed")
    expect(state(summary, "harness")).toBe("missing")
    expect(state(summary, "attempts")).toBe("missing")
  })

  it("does not let a library name alone stand for a re-runnable harness", () => {
    // eval_library is on 99% of rows; without a version or task config it is
    // not something anybody can re-run.
    const summary = evaluateReproducibilitySlots({ row: { eval_library: "lm-evaluation-harness" } })
    expect(state(summary, "harness")).toBe("disclosed")
    expect(state(summary, "harness_pin")).toBe("missing")
  })

  it("counts a task config or version as the harness pin", () => {
    const summary = evaluateReproducibilitySlots({
      generation_config: { additional_details: { lm_eval_task: "leaderboard_bbh_snarks" } },
    })
    expect(state(summary, "harness_pin")).toBe("disclosed")
  })

  it("counts the scored item count as the test set", () => {
    const summary = evaluateReproducibilitySlots({ score: { sample_size: 86 } })
    expect(state(summary, "test_set")).toBe("disclosed")
    expect(summary.slots.find((s) => s.id === "test_set")?.value).toBe(86)
  })

  it("does not score uncertainty statistics — they are not re-run inputs", () => {
    const summary = evaluateReproducibilitySlots({
      score: { standard_error: 0.036, confidence_interval: { lower: 0.1, upper: 0.2 } },
    })
    expect(summary.disclosed).toBe(0)
  })

  it("counts a repeat count as attempts", () => {
    const summary = evaluateReproducibilitySlots({
      protocol: { scaffold: "ReAct", epochs: 5 },
    })
    expect(state(summary, "attempts")).toBe("disclosed")
    expect(summary.slots.find((s) => s.id === "attempts")?.value).toBe(5)
  })

  it("marks a slot unknown, not missing, when applicability cannot be determined", () => {
    // A bare row: hosted model, nothing disclosed. We cannot tell whether it
    // was a reasoning run, so neither the reasoning nor the decoding slot may
    // be counted against it.
    const summary = evaluateReproducibilitySlots({})
    expect(state(summary, "reasoning_budget")).toBe("unknown")
    expect(state(summary, "decoding")).toBe("unknown")
    expect(state(summary, "attempts")).toBe("unknown")
    expect(state(summary, "length")).toBe("unknown")
    // Only the genuinely always-on slots remain (harness, harness version,
    // test set), all undisclosed. Everything else depends on facts this row
    // does not carry.
    expect(summary.applicable).toBe(3)
    expect(summary.disclosed).toBe(0)
    expect(summary.ratio).toBe(0)
  })

  it("lets a disclosed value settle its own applicability", () => {
    // The source would not report a reasoning budget for a run without one.
    const summary = evaluateReproducibilitySlots({
      generation_args: { reasoning: true },
    })
    expect(state(summary, "reasoning_budget")).toBe("disclosed")
  })

  it("reports which path satisfied a slot", () => {
    const summary = evaluateReproducibilitySlots({ protocol: { token_limit: 10_000_000 } })
    expect(summary.slots.find((s) => s.id === "length")?.satisfiedBy).toBe("protocol.token_limit")
  })

  it("gives a reason whenever a slot leaves the denominator", () => {
    const summary = evaluateReproducibilitySlots({ protocol: { reasoning_effort: "high" } })
    for (const slot of summary.slots) {
      if (slot.state === "not_applicable" || slot.state === "unknown") {
        expect(slot.reason).toBeTruthy()
      }
    }
  })
})

describe("scoring mode", () => {
  it("marks sampling and length n/a on a log-prob run", () => {
    // ~25% of the corpus is scored from log-probabilities: nothing is
    // sampled and nothing is generated, so temperature and max_tokens are
    // absent by nature. Every one of those rows counted as a gap before.
    const summary = evaluateReproducibilitySlots({
      generation_config: { additional_details: { output_type: "multiple_choice" } },
      model: { open_weights: true },
    })
    expect(state(summary, "decoding")).toBe("not_applicable")
    expect(state(summary, "length")).toBe("not_applicable")
    // Raw vs length-normalised accuracy is NOT asked: sources report a
    // metric id of "accuracy" for both, so the slot could only be satisfied
    // by a label that does not disambiguate.
    expect(summary.slots.some((slot) => slot.id === "scoring_variant")).toBe(false)
  })

  it("treats loglikelihood and loglikelihood_rolling the same way", () => {
    for (const output_type of ["loglikelihood", "loglikelihood_rolling"]) {
      const summary = evaluateReproducibilitySlots({
        generation_config: { additional_details: { output_type } },
      })
      expect(state(summary, "decoding")).toBe("not_applicable")
    }
  })

  it("keeps generate_until generative", () => {
    const summary = evaluateReproducibilitySlots({
      generation_config: { additional_details: { output_type: "generate_until" } },
    })
    expect(state(summary, "decoding")).toBe("missing")
    expect(state(summary, "length")).toBe("missing")
  })

  it("reads a reward model's classifier type as log-prob", () => {
    for (const model_type of ["Seq. Classifier", "Custom Classifier", "DPO"]) {
      const summary = evaluateReproducibilitySlots({
        model: { additional_details: { model_type } },
      })
      expect(state(summary, "decoding")).toBe("not_applicable")
    }
    const generative = evaluateReproducibilitySlots({
      model: { additional_details: { model_type: "Generative RM" } },
    })
    expect(state(generative, "decoding")).toBe("missing")
  })

  it("leaves mode unknown rather than guessing, and drops those slots", () => {
    // HF Open LLM v2 carries no output_type in the EEE record — the harness
    // dumps have it, the warehouse does not. Unknown must not read as a gap.
    const summary = evaluateReproducibilitySlots({ model: { open_weights: true } })
    expect(state(summary, "decoding")).toBe("unknown")
    expect(state(summary, "length")).toBe("unknown")
  })

  it("never guesses the mode from the benchmark name", () => {
    // helm_* does multiple choice by GENERATING the answer letter.
    const summary = evaluateReproducibilitySlots({
      row: { eval_library: "helm_mmlu", benchmark_id: "helm_mmlu" },
    })
    expect(state(summary, "decoding")).toBe("unknown")
  })

  it("omits retired slots entirely rather than showing them as n/a", () => {
    const summary = evaluateReproducibilitySlots({})
    expect(summary.slots.some((slot) => slot.id === "prompt_format")).toBe(false)
    expect(summary.slots.some((slot) => slot.id === "model_build")).toBe(false)
    expect(summary.slots.some((slot) => slot.id === "scoring_variant")).toBe(false)
  })
})

describe("evidenceFromResult", () => {
  it("reads decoding args, protocol and agentic limits from where the producer puts them", () => {
    const evidence = evidenceFromResult({
      generation_config: {
        generation_args: { temperature: 0.7, max_tokens: 4096 },
        prompt_template: "zero-shot",
        additional_details: JSON.stringify({
          eval_limits: { message_limit: 30 },
          eval_plan: { name: "react", steps: [1, 2] },
        }),
      },
      protocol_condition: JSON.stringify({ scaffold: "S-adaptive" }),
      model_info: { open_weights: false },
    })
    expect(evidence.generation_args?.temperature).toBe(0.7)
    expect(evidence.protocol?.scaffold).toBe("S-adaptive")
    expect(evidence.limits?.message_limit).toBe(30)
    expect((evidence.agent?.eval_plan as { name: string }).name).toBe("react")
    expect(evidence.model?.open_weights).toBe(false)
  })

  it("survives null and malformed config without throwing", () => {
    const evidence = evidenceFromResult({
      generation_config: null,
      protocol_condition: "not json",
    })
    expect(evaluateReproducibilitySlots(evidence).applicable).toBe(3)
  })
})
