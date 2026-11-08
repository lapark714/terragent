/**
 * Rule-based report checklist (VERIFIER_CHECKS). "Hard" checks are objective and block a passing verdict;
 * "soft" ones are heuristics the Verifier must judge for itself.
 */
import { type AcquisitionPlan, type AnalysisResult, Confidence, type Recipe, type ReportDraft, VERIFIER_CHECKS } from "../domain";
import { latestAnalysis } from "./analyses";
import { requireReport } from "./reports";
import { requireRequest } from "./requests";

type CheckId = (typeof VERIFIER_CHECKS)[number];
export interface RuleCheck { id: CheckId; pass: boolean; hard: boolean; note: string }

export interface RuleInput {
  report: Pick<ReportDraft, "title" | "answer" | "confidence" | "measurements" | "images" | "sources" | "limitations" | "human_review_recommended">;
  question: string;
  playbook: string;
  recipe: Recipe | null;
  analysis: AnalysisResult | null;
  planChoice: AcquisitionPlan["choice"] | null;
}

const FREE_SOURCE = /sentinel|landsat|copernicus|usgs|planetary computer|nasa|esa\b/i;
// Specific phrases only: this check is hard, so a bare "claim", "safety", "evidence" or "investigate" must not trip it.
const HIGH_STAKES = new RegExp(
  [
    "insur(e|ed|er|ers|ance|ances)", "(insurance|damage|property|legal) claims?", "claims? adjust\\w*", "(file|filing|submit) (a|an|my|our) claim", "adjusters?",
    "legal(ly)?", "lawsuits?", "litigation", "in court", "court (case|order|filing)s?", "(legal|court) evidence", "evidence (for|in) (court|a claim|litigation)",
    "life safety", "public safety", "safe to (return|enter|live|occupy)", "evacuat\\w*", "structural(ly)?", "mortgages?", "loans?", "lend(ing|er|ers)",
    "compliance", "eudr", "regulat(ion|ions|ory|or|ors)", "due diligence", "invest(ment|ments|or|ors|ing)?",
  ].map((p) => `\\b${p}\\b`).join("|"),
  "i",
);
const MINING_OVERCLAIM = /\b(deposits?|ore ?bod(y|ies)|(mineral |proven |probable )?reserves|confirmed mineralization|economic(ally)? viable)\b/gi;
const NEGATION = /\b(not|no|never|cannot|can't|isn't|aren't|without|nor)\b[^.]*$/i;

function sentences(text: string): number {
  return text.split(/[.!?]+(\s|$)/).filter((s) => s && s.trim().length > 2).length;
}

/** Every number the analysis produced, for matching report measurements against. */
function analysisNumbers(a: AnalysisResult): number[] {
  const out: number[] = [];
  for (const i of a.indices) for (const v of [i.before_mean, i.after_mean, i.delta, i.affected_area_km2]) if (v !== null) out.push(v);
  for (const s of [a.before, a.after]) if (s) out.push(s.clear_fraction, s.clear_fraction * 100, ...(s.cloud_pct === null ? [] : [s.cloud_pct]));
  return out;
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.005, Math.abs(b) * 0.02);

export function evaluateRules(x: RuleInput): RuleCheck[] {
  const r = x.report;
  const roles = new Set(r.images.map((i) => i.role));
  const needsBefore = x.recipe !== "true_color" && !!x.analysis?.before;
  const text = `${r.title}\n${r.answer}\n${r.measurements.map((m) => m.note ?? "").join("\n")}`;
  const isMining = x.recipe === "mining_indicators" || x.playbook === "mining";

  const overclaims = isMining
    ? [...text.matchAll(MINING_OVERCLAIM)].filter((m) => !NEGATION.test(text.slice(Math.max(0, m.index! - 60), m.index))).map((m) => m[0])
    : [];
  const unsupported = x.analysis
    ? r.measurements.flatMap((m) => [m.value, m.before, m.after].filter((v): v is number => v !== null).filter((v) => !analysisNumbers(x.analysis!).some((n) => close(v, n))).map((v) => `${m.metric}=${v}`))
    : [];
  const undated = r.sources.filter((s) => (s.collection || s.item_id) && !s.datetime).map((s) => s.name);
  const rawImages = r.images.filter((i) => (i.role === "before" || i.role === "after") && !FREE_SOURCE.test(i.source)).map((i) => i.source);
  const highStakes = HIGH_STAKES.test(x.question);

  const check = (id: CheckId, hard: boolean, pass: boolean, note: string): RuleCheck => ({ id, hard, pass, note });
  return [
    check("answers_the_question", false, r.answer.trim().length >= 60 && sentences(r.answer) >= 1 && sentences(r.answer) <= 8,
      `Heuristic (length and 1-8 sentences). Judge whether it really answers: "${x.question.slice(0, 160)}"`),
    check("has_before_and_after_images", true, roles.has("after") && (!needsBefore || roles.has("before")),
      needsBefore ? "Needs a before and an after image." : "Needs an after image (no comparison scene)."),
    check("has_measurements", true, x.recipe === "true_color" || r.measurements.some((m) => m.value !== null || m.after !== null),
      "At least one measurement with a value."),
    check("has_confidence", true, Confidence.safeParse(r.confidence).success, `confidence = ${r.confidence}`),
    check("has_dated_sources", true, r.sources.length > 0 && undated.length === 0 && r.sources.some((s) => s.datetime),
      undated.length ? `Undated imagery sources: ${undated.join(", ")}` : "Every imagery source has a date."),
    check("has_limitations", true, r.limitations.trim().length >= 40, "Limitations must cover resolution, clouds, dates and what this can't tell."),
    check("claims_supported_by_measurements", false, x.planChoice === "existing_index" || (!!x.analysis && unsupported.length === 0),
      !x.analysis && x.planChoice !== "existing_index" ? "No saved analysis to support the numbers."
        : unsupported.length ? `Numbers not found in the analysis: ${unsupported.join(", ")}` : "Every number matches the analysis."),
    check("mining_language_is_indicator_only", true, !isMining || (overclaims.length === 0 && /indicator/i.test(text)),
      !isMining ? "Not a mining report." : overclaims.length ? `Overclaiming words: ${overclaims.join(", ")}` : "Must call results indicators, never deposits."),
    check("no_raw_licensed_imagery", true, rawImages.length === 0,
      rawImages.length ? `Before/after images from non-free sources: ${rawImages.join(", ")}. Show derived maps only.` : "Only free imagery or derived products."),
    check("high_stakes_flagged", true, !highStakes || r.human_review_recommended,
      highStakes ? "High-stakes use (insurance/legal/safety/finance): human_review_recommended must be true." : "Not a high-stakes question."),
  ];
}

export async function checkReportRules(reportId: string) {
  const report = await requireReport(reportId);
  const req = await requireRequest(report.request_id);
  const analysisRow = await latestAnalysis(req.id);
  const spec = req.data_spec as { recipe?: Recipe } | null;
  const checks = evaluateRules({
    report, question: req.question, playbook: req.playbook,
    recipe: analysisRow?.result.recipe ?? spec?.recipe ?? null, analysis: analysisRow?.result ?? null,
    planChoice: (req.acquisition_plan as AcquisitionPlan | null)?.choice ?? null,
  });
  const hardFailures = checks.filter((c) => c.hard && !c.pass).map((c) => c.id);
  return {
    report_id: report.id, score: Math.round((100 * checks.filter((c) => c.pass).length) / checks.length),
    hard_failures: hardFailures, checks,
  };
}
