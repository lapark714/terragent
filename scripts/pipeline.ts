/**
 * Usage: npm run pipeline -- --job job.json --out tmp/out
 * Runs the imagery pipeline CLI (docs/ARCHITECTURE.md §10) from pipeline/.venv, validates the AnalysisResult and
 * prints it as one line of JSON. Progress goes to stderr. Needs `bash pipeline/bootstrap.sh` once.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { runPipelineLocally, type PipelineJob } from "../src/lib/imagery/local-pipeline";

const { values } = parseArgs({ options: { job: { type: "string" }, out: { type: "string" } } });
if (!values.job || !values.out) {
  console.error("usage: npm run pipeline -- --job job.json --out <dir>");
  process.exit(2);
}
const job = JSON.parse(await readFile(values.job, "utf8")) as PipelineJob;
const result = await runPipelineLocally(job, values.out, { onLog: (line) => console.error(line) });
console.log(JSON.stringify(result));
