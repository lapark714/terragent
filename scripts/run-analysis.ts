/**
 * Run a request's analysis stage server-side on the Analytics agent's Naïve computer, save it, and hand off to the
 * interpreter. Same path the terragent.run_analysis tool uses.
 *   npx tsx scripts/run-analysis.ts <request_id> [--no-handoff]
 */
import "dotenv/config";
import { runPipelineOnNaive } from "../src/lib/naive/compute";
import { getAnalysisJob, saveAnalysis } from "../src/lib/pipeline/analyses";
import { handoff } from "../src/lib/pipeline/requests";

const [requestId, ...flags] = process.argv.slice(2);
if (!requestId) throw new Error("usage: run-analysis.ts <request_id> [--no-handoff]");
const job = await getAnalysisJob(requestId);
console.log("job", JSON.stringify(job.job).slice(0, 240));
const run = await runPipelineOnNaive(job.job as Record<string, unknown>, requestId);
console.log("timings", JSON.stringify(run.timings), "| installed bundle:", run.installed);
console.log("indices", JSON.stringify(run.result.indices.map((i) => ({ name: i.name, delta: i.delta, area: i.affected_area_km2 }))));
console.log("images", Object.keys(run.fileIds).length, "| warnings", JSON.stringify(run.result.warnings).slice(0, 300));
const saved = await saveAnalysis({ requestId, result: run.result, fileIds: run.fileIds }, "analytics");
console.log("saved", JSON.stringify(saved).slice(0, 200));
if (!flags.includes("--no-handoff")) {
  const h = await handoff({ requestId, from: "analytics", to: "interpreter", stage: "report",
    instructions: "Analysis saved (server-run on the analytics computer). Write the report from get_analysis: answer, confidence, measurements, before/after images, dated sources, limitations; then check_report_rules and hand off to verifier." });
  console.log("handoff", JSON.stringify(h));
}
process.exit(0);
