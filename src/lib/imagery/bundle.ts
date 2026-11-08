/**
 * OWNER: imagery builder. Packs pipeline/ into a .tgz that the Analytics agent fetches into its Naïve computer and
 * unpacks with `tar -xzf` (docs/ARCHITECTURE.md §10). Plain ustar written here rather than by the system tar, so
 * there are no macOS xattrs or AppleDouble files, and the same sources always give the same sha256.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

/** Never shipped: the venv is rebuilt by bootstrap.sh; tests and caches are dev-only. */
const EXCLUDE = new Set([".venv", "tests", "__pycache__", ".pytest_cache", ".DS_Store", "requirements-dev.txt"]);

export interface TarEntry {
  name: string; // posix path inside the archive; a trailing "/" makes a directory
  data: Buffer;
  mode: number;
}

export interface PipelineBundle {
  path: string;
  bytes: number;
  sha256: string;
  files: string[];
}

/** Files under `dir` (posix paths relative to dir's parent, e.g. "pipeline/bootstrap.sh"), sorted, with modes. */
export async function collectEntries(dir: string): Promise<TarEntry[]> {
  const base = path.basename(dir);
  const out: TarEntry[] = [{ name: `${base}/`, data: Buffer.alloc(0), mode: 0o755 }];
  async function walk(rel: string) {
    const entries = (await readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (EXCLUDE.has(e.name) || e.name.endsWith(".pyc")) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({ name: `${base}/${child}/`, data: Buffer.alloc(0), mode: 0o755 });
        await walk(child);
      } else if (e.isFile()) {
        const full = path.join(dir, child);
        const executable = ((await stat(full)).mode & 0o111) !== 0;
        out.push({ name: `${base}/${child}`, data: await readFile(full), mode: executable ? 0o755 : 0o644 });
      }
    }
  }
  await walk("");
  return out;
}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

/**
 * Each file's mtime is derived from its content: deterministic archives, yet a changed file always gets a new
 * mtime, so Python never trusts a stale __pycache__ left on the computer by an earlier bundle.
 */
function contentMtime(data: Buffer): number {
  return 1_700_000_000 + (createHash("sha256").update(data).digest().readUInt32BE(0) % 50_000_000);
}

function header(e: TarEntry): Buffer {
  const dir = e.name.endsWith("/");
  if (Buffer.byteLength(e.name) > 100) throw new Error(`path too long for ustar: ${e.name}`);
  const h = Buffer.alloc(512);
  h.write(e.name, 0, 100, "utf8");
  h.write(octal(e.mode, 8), 100, 8, "ascii");
  h.write(octal(0, 8), 108, 8, "ascii"); // uid
  h.write(octal(0, 8), 116, 8, "ascii"); // gid
  h.write(octal(dir ? 0 : e.data.length, 12), 124, 12, "ascii");
  h.write(octal(contentMtime(e.data), 12), 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii"); // checksum placeholder (spaces) while summing
  h.write(dir ? "5" : "0", 156, 1, "ascii");
  h.write("ustar\0" + "00", 257, 8, "ascii");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(octal(sum, 7) + " ", 148, 8, "ascii");
  return h;
}

export function tarGz(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(header(e));
    if (!e.name.endsWith("/") && e.data.length) {
      parts.push(e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024)); // end-of-archive marker
  const gz = gzipSync(Buffer.concat(parts), { level: 9 });
  gz[9] = 3; // gzip OS byte: zlib writes 7 on macOS and 3 on Linux; pin it so the sha256 matches everywhere
  return gz;
}

/** Writes <root>/<out> (default dist/pipeline-bundle.tgz) from <root>/pipeline. */
export async function buildPipelineBundle(
  opts: { root?: string; out?: string } = {},
): Promise<PipelineBundle> {
  const root = path.resolve(opts.root ?? process.cwd());
  const entries = await collectEntries(path.join(root, "pipeline"));
  const gz = tarGz(entries);
  const file = path.join(root, opts.out ?? path.join("dist", "pipeline-bundle.tgz"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, gz);
  return {
    path: file,
    bytes: gz.length,
    sha256: createHash("sha256").update(gz).digest("hex"),
    files: entries.filter((e) => !e.name.endsWith("/")).map((e) => e.name),
  };
}
