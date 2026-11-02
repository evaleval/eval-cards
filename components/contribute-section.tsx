import Link from "next/link"

const linkCls = "text-[color:var(--fg)] underline underline-offset-2 hover:opacity-80"
const EEE_SITE = "https://evalevalai.com/every_eval_ever/"
const EEE_ISSUES = "https://github.com/evaleval/every_eval_ever/issues"
const GH_ISSUES = "https://github.com/evaleval/eval-cards/issues"
const ROADMAP = "https://changemap.co/evaleval/evalcards/"

/**
 * The "How to contribute" body — per-stakeholder ways to help, plus the general
 * channels. Shared by the Help and About pages so it stays in one place.
 */
export function ContributeSection() {
  return (
    <>
      <p className="mb-5 max-w-[720px] text-[15px] leading-[1.7] text-[color:var(--fg-muted)]">
        Evaluation Cards is a living, community artifact — its coverage and usefulness grow as
        people report, upload, use, and cite it. Here's what helps most, depending on who you are.
      </p>
      <div className="grid gap-5 sm:grid-cols-2">
        {/* MODEL DEVELOPERS */}
        <div className="border border-[color:var(--border-soft)] bg-[color:var(--bg-warm)] p-[22px]">
          <div className="kicker mb-2">Model developers</div>
          <ul className="m-0 list-disc space-y-2 pl-4 text-[13.5px] leading-[1.6] text-[color:var(--fg-muted)] marker:text-[color:var(--fg-subtle)]">
            <li>
              Report your model's results to{" "}
              <a href={EEE_SITE} target="_blank" rel="noreferrer" className={linkCls}>
                Every Eval Ever
              </a>{" "}
              so they show up here in context.
            </li>
            <li>
              Already on EEE?{" "}
              <Link href="/help/cross-post-to-hugging-face" className={linkCls}>
                Cross-post them to Hugging Face
              </Link>{" "}
              so your scores appear on the model page with a backlink.
            </li>
            <li>
              Disclose the setup items that raise your reproducibility signal: decoding, reasoning
              budget, output length, harness and its version, context handling, test set, and attempts.
            </li>
            <li>
              See a wrong or missing number for your model? Flag it in the{" "}
              <a href={GH_ISSUES} target="_blank" rel="noreferrer" className={linkCls}>
                Eval Cards issue tracker
              </a>{" "}
              or via each record's correction path.
            </li>
          </ul>
        </div>

        {/* EVALUATION DEVELOPERS */}
        <div className="border border-[color:var(--border-soft)] bg-[color:var(--bg-warm)] p-[22px]">
          <div className="kicker mb-2">Evaluation developers</div>
          <ul className="m-0 list-disc space-y-2 pl-4 text-[13.5px] leading-[1.6] text-[color:var(--fg-muted)] marker:text-[color:var(--fg-subtle)]">
            <li>
              Upload your benchmark's results to{" "}
              <a href={EEE_SITE} target="_blank" rel="noreferrer" className={linkCls}>
                Every Eval Ever
              </a>{" "}
              so others can find, run, and reuse them.
            </li>
            <li>
              Fill in your benchmark's metadata — goals, construct, scoring rubric, intended uses,
              and limitations — to raise its{" "}
              <Link href="/help/how-signals-are-computed" className={linkCls}>
                completeness score
              </Link>
              .
            </li>
            <li>
              Report schema gaps or data issues on the{" "}
              <a href={EEE_ISSUES} target="_blank" rel="noreferrer" className={linkCls}>
                EEE issue tracker
              </a>
              .
            </li>
          </ul>
        </div>

        {/* RESEARCHERS */}
        <div className="border border-[color:var(--border-soft)] bg-[color:var(--bg-warm)] p-[22px]">
          <div className="kicker mb-2">Researchers</div>
          <ul className="m-0 list-disc space-y-2 pl-4 text-[13.5px] leading-[1.6] text-[color:var(--fg-muted)] marker:text-[color:var(--fg-subtle)]">
            <li>
              Use Evaluation Cards in your model-, evaluation-, or field-level analysis — and{" "}
              <Link href="/about#how-to-cite" className={linkCls}>
                cite the paper
              </Link>{" "}
              when you build on it.
            </li>
            <li>
              Report third-party results you've run to{" "}
              <a href={EEE_SITE} target="_blank" rel="noreferrer" className={linkCls}>
                Every Eval Ever
              </a>{" "}
              — independent numbers are first-class here.
            </li>
            <li>
              Flag discrepancies or suggest methodology improvements on the{" "}
              <a href={EEE_ISSUES} target="_blank" rel="noreferrer" className={linkCls}>
                EEE issue tracker
              </a>{" "}
              or the{" "}
              <a href={GH_ISSUES} target="_blank" rel="noreferrer" className={linkCls}>
                Eval Cards issue tracker
              </a>
              .
            </li>
            <li>Spread the word — share it with collaborators and on socials.</li>
          </ul>
        </div>

        {/* POLICYMAKERS */}
        <div className="border border-[color:var(--border-soft)] bg-[color:var(--bg-warm)] p-[22px]">
          <div className="kicker mb-2">Policymakers</div>
          <ul className="m-0 list-disc space-y-2 pl-4 text-[13.5px] leading-[1.6] text-[color:var(--fg-muted)] marker:text-[color:var(--fg-subtle)]">
            <li>
              Consult Evaluation Cards as an evidence base — what's documented, who reported it, and
              how comparable it is.
            </li>
            <li>
              <Link href="/about#how-to-cite" className={linkCls}>
                Cite the paper
              </Link>{" "}
              in reports and briefings, and point colleagues to the site.
            </li>
            <li>
              Tell us what evidence you need for decisions — suggest features on the{" "}
              <a href={ROADMAP} target="_blank" rel="noreferrer" className={linkCls}>
                public roadmap
              </a>{" "}
              or via the{" "}
              <Link href="/feedback" className={linkCls}>
                feedback form
              </Link>
              .
            </li>
            <li>Spread the word so more of the field reports legibly.</li>
          </ul>
        </div>
      </div>

      <p className="mt-5 text-[14px] leading-[1.7] text-[color:var(--fg-muted)]">
        <strong className="font-semibold text-[color:var(--fg)]">Spotted an error?</strong> A wrong
        or missing number anywhere in the corpus can be flagged through the{" "}
        <Link href="/feedback" className={linkCls}>
          feedback form
        </Link>{" "}
        with a source — corrections are versioned, and coverage improves as developers and third
        parties publish.
      </p>

      <p className="mt-3 text-[14px] leading-[1.7] text-[color:var(--fg-muted)]">
        Not sure where something fits? The{" "}
        <a href={ROADMAP} target="_blank" rel="noreferrer" className={linkCls}>
          public roadmap
        </a>
        , the{" "}
        <Link href="/feedback" className={linkCls}>
          feedback form
        </Link>
        , the{" "}
        <a href={EEE_ISSUES} target="_blank" rel="noreferrer" className={linkCls}>
          EEE issue tracker
        </a>
        , and the{" "}
        <a href={GH_ISSUES} target="_blank" rel="noreferrer" className={linkCls}>
          Eval Cards issue tracker
        </a>{" "}
        are always open.
      </p>
    </>
  )
}
