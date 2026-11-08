/** OWNER: imagery builder. Run the Python pipeline locally (tests, simulator, local dev). Not used on Vercel. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AnalysisResult } from "../domain";

export interface PipelineJob {
  request_id: string; recipe: string; bbox: [number, number, number, number];
  before_window: { start: string; end: string } | null; after_window: { start: string; end: string };
  before_scene: unknown | null; after_scene: unknown | null; max_cloud_pct: number; h3_res: number; collection?: string;
}

export interface RunPipelineOptions {
  /** The repo's pipeline/ directory (holds .venv). Default: <cwd>/pipeline. */
  pipelineDir?: string;
  /** Kill the run after this long. Default 180 s (the contract target is < 60 s per job). */
  timeoutMs?: number;
  /** Progress lines the pipeline writes to stderr. */
  onLog?: (line: string) => void;
}

/**
 * Spawns pipeline/.venv python (see docs/ARCHITECTURE.md §10). Image paths in the result are relative to outDir.
 * Writes the job to <outDir>/job.json first, exactly as the Analytics agent does in its computer.
 */
export async function runPipelineLocally(
  job: PipelineJob,
  outDir: string,
  opts: RunPipelineOptions = {},
): Promise<AnalysisResult> {
  const dir = path.resolve(opts.pipelineDir ?? path.join(process.cwd(), "pipeline"));
  const python = path.join(dir, ".venv", "bin", "python");
  if (!existsSync(python)) throw new Error(`No pipeline venv at ${python}. Run: bash pipeline/bootstrap.sh`);
  const out = path.resolve(outDir);
  await mkdir(out, { recursive: true });
  const jobPath = path.join(out, "job.json");
  await writeFile(jobPath, JSON.stringify({ collection: "sentinel-2-l2a", ...job }, null, 1));

  const args = ["-m", "terragent_pipeline.run", "--job", jobPath, "--out", out];
  const { code, stdout, stderr } = await run(python, args, dir, opts.timeoutMs ?? 180_000, opts.onLog);
  if (code !== 0) throw new Error(`pipeline exited with ${code}: ${stderr.trim().split("\n").slice(-5).join(" | ")}`);
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    return AnalysisResult.parse(JSON.parse(line));
  } catch (e) {
    throw new Error(`pipeline printed an invalid AnalysisResult: ${(e as Error).message}`);
  }
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number, onLog?: (line: string) => void) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    // cwd = pipeline/ so `-m terragent_pipeline.run` resolves even without bootstrap's .pth file.
    const child = spawn(cmd, args, { cwd, env: { ...process.env, PYTHONUNBUFFERED: "1" } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pipeline timed out after ${timeoutMs / 1000} s`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
      if (onLog) for (const l of d.toString().split("\n")) if (l.trim()) onLog(l);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
