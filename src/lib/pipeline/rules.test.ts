import { describe, expect, it } from "vitest";
import { evaluateRules, type RuleInput } from "./rules";
import { sampleAnalysis, sampleDraft } from "./testing";

const base = (over: Partial<RuleInput> = {}): RuleInput => ({
  report: sampleDraft("req_x"), question: "Did the fire reach our street?", playbook: "inbound", recipe: "burn_severity",
  analysis: sampleAnalysis(), planChoice: "free", ...over,
});
const failing = (x: RuleInput) => evaluateRules(x).filter((c) => !c.pass).map((c) => c.id);

describe("evaluateRules", () => {
  it("passes a complete free-data report", () => {
    expect(failing(base())).toEqual([]);
  });

  it("needs before and after images when the analysis compared two scenes", () => {
    const report = sampleDraft("req_x");
    report.images = report.images.filter((i) => i.role !== "before");
    expect(failing(base({ report }))).toEqual(["has_before_and_after_images"]);
  });

  it("flags undated imagery sources and short limitations", () => {
    const report = sampleDraft("req_x", { limitations: "Clouds." });
    report.sources[0].datetime = null;
    expect(failing(base({ report }))).toEqual(["has_dated_sources", "has_limitations"]);
  });

  it("flags numbers the analysis never produced", () => {
    const report = sampleDraft("req_x");
    report.measurements[0].value = 0.9;
    expect(failing(base({ report }))).toEqual(["claims_supported_by_measurements"]);
  });

  it("mining reports must speak in indicators, never deposits (negations are fine)", () => {
    const answer = "The site shows strong iron-oxide indicators. This is a large copper deposits zone with reserves to mine and more.";
    const ok = "The site shows strong iron-oxide indicators over 2 km². This is not evidence of a deposit, only surface indicators.";
    expect(failing(base({ recipe: "mining_indicators", analysis: null, planChoice: "existing_index", report: sampleDraft("req_x", { answer }) })))
      .toContain("mining_language_is_indicator_only");
    expect(failing(base({ recipe: "mining_indicators", analysis: null, planChoice: "existing_index", report: sampleDraft("req_x", { answer: ok }) })))
      .not.toContain("mining_language_is_indicator_only");
  });

  it("never lets purchased before/after imagery through", () => {
    const report = sampleDraft("req_x");
    report.images[1].source = "Pléiades Neo (Airbus)";
    expect(failing(base({ report, planChoice: "paid" }))).toEqual(["no_raw_licensed_imagery"]);
  });

  it("high-stakes questions need human review recommended", () => {
    const q = "Can I use this for my insurance claim on the house?";
    expect(failing(base({ question: q }))).toEqual(["high_stakes_flagged"]);
    expect(failing(base({ question: q, report: sampleDraft("req_x", { human_review_recommended: true }) }))).toEqual([]);
    for (const risky of ["Is it safe to return to the house?", "Is the farm EUDR compliant?", "We are an investor in the mine.", "Will the adjuster see this?"]) {
      expect(failing(base({ question: risky }))).toEqual(["high_stakes_flagged"]);
    }
  });

  it("ordinary words that only look high-stakes don't force human review", () => {
    for (const q of [
      "Can you investigate whether the fire reached our depot?",
      "They claim the flood never reached the road; did it?",
      "Is there evidence the forest was cleared last month?",
      "Did the new safety fence around the quarry go up?",
    ]) expect(failing(base({ question: q }))).toEqual([]);
  });

  it("marks the objective checks hard and the judgement calls soft", () => {
    const soft = evaluateRules(base()).filter((c) => !c.hard).map((c) => c.id);
    expect(soft).toEqual(["answers_the_question", "claims_supported_by_measurements"]);
  });
});
