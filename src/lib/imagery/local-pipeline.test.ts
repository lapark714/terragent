import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runPipelineLocally, type PipelineJob } from "./local-pipeline";

const JOB: PipelineJob = {
  request_id: "req_t",
  recipe: "true_color",
  bbox: [-118.2608, 34.041, -118.2392, 34.059],
  before_window: null,
  after_window: { start: "2026-09-01", end: "2026-11-07" },
  before_scene: null,
  after_scene: null,
  max_cloud_pct: 20,
  h3_res: 8,
};

const RESULT = {
  recipe: "true_color",
  bbox: JOB.bbox,
  before: null,
  after: { collection: "sentinel-2-l2a", item_id: "S2C_X", datetime: "2026-11-03T18:35:31Z", cloud_pct: 56.3, clear_fraction: 1 },
  indices: [{ name: "ndvi", before_mean: null, after_mean: 0.129, delta: null, unit: null, affected_area_km2: null, threshold: null }],
  images: [{ role: "after", path: "after_true_color.png", caption: "After" }],
  h3_metrics: [{ h3_cell: "8829a1d625fffff", h3_res: 8, metric: "ndvi_mean", value: 0.18 }],
  timings_s: { total: 7.3 },
  warnings: [],
};

/** A fake pipeline/ whose .venv/bin/python is a shell script: prints `stdout`, logs to stderr, exits `code`. */
async function fakePipeline(stdout: string, code = 0): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tg-pipeline-"));
  await mkdir(path.join(dir, ".venv", "bin"), { recursive: true });
  const py = path.join(dir, ".venv", "bin", "python");
  await writeFile(py, `#!/bin/sh\necho "[pipeline] working" >&2\necho "$@" > "$(dirname "$0")/args"\ncat <<'EOF'\n${stdout}\nEOF\nexit ${code}\n`);
  await chmod(py, 0o755);
  return dir;
}

describe("runPipelineLocally", () => {
  it("writes job.json, runs the CLI and returns the validated AnalysisResult", async () => {
    const dir = await fakePipeline(JSON.stringify(RESULT));
    const out = path.join(dir, "out");
    const logs: string[] = [];
    const result = await runPipelineLocally(JOB, out, { pipelineDir: dir, onLog: (l) => logs.push(l) });
    expect(result.after?.item_id).toBe("S2C_X");
    expect(logs).toEqual(["[pipeline] working"]);
    const job = JSON.parse(await readFile(path.join(out, "job.json"), "utf8"));
    expect(job).toMatchObject({ ...JOB, collection: "sentinel-2-l2a" });
    const args = (await readFile(path.join(dir, ".venv", "bin", "args"), "utf8")).trim();
    expect(args).toBe(`-m terragent_pipeline.run --job ${path.join(out, "job.json")} --out ${out}`);
  });

  it("rejects output that is not an AnalysisResult", async () => {
    const dir = await fakePipeline(JSON.stringify({ ...RESULT, recipe: "deposits" }));
    await expect(runPipelineLocally(JOB, path.join(dir, "out"), { pipelineDir: dir })).rejects.toThrow("invalid AnalysisResult");
  });

  it("surfaces crashes with the end of stderr", async () => {
    const dir = await fakePipeline("", 1);
    await expect(runPipelineLocally(JOB, path.join(dir, "out"), { pipelineDir: dir })).rejects.toThrow(
      "pipeline exited with 1: [pipeline] working",
    );
  });

  it("explains how to bootstrap when the venv is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tg-empty-"));
    await expect(runPipelineLocally(JOB, path.join(dir, "out"), { pipelineDir: dir })).rejects.toThrow("bootstrap.sh");
  });
});
