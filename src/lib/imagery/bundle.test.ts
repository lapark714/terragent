import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPipelineBundle } from "./bundle";

async function fakeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "tg-bundle-"));
  const files: Record<string, string> = {
    "pipeline/bootstrap.sh": "#!/usr/bin/env bash\necho ready\n",
    "pipeline/requirements.txt": "numpy==2.5.4\n",
    "pipeline/requirements-dev.txt": "pytest\n",
    "pipeline/terragent_pipeline/__init__.py": "",
    "pipeline/terragent_pipeline/run.py": "print('x' * 600)\n",
    "pipeline/terragent_pipeline/__pycache__/run.cpython-313.pyc": "junk",
    "pipeline/tests/test_x.py": "def test(): pass\n",
    "pipeline/.venv/bin/python": "junk",
  };
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body);
  }
  await chmod(path.join(root, "pipeline/bootstrap.sh"), 0o755);
  return root;
}

describe("buildPipelineBundle", () => {
  it("packs pipeline/ without venv, tests and caches, readable by the system tar", async () => {
    const root = await fakeRepo();
    const bundle = await buildPipelineBundle({ root });
    expect(bundle.path).toBe(path.join(root, "dist", "pipeline-bundle.tgz"));
    expect(bundle.files).toEqual([
      "pipeline/bootstrap.sh",
      "pipeline/requirements.txt",
      "pipeline/terragent_pipeline/__init__.py",
      "pipeline/terragent_pipeline/run.py",
    ]);
    expect(bundle.bytes).toBe((await stat(bundle.path)).size);
    expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/);

    const dest = await mkdtemp(path.join(tmpdir(), "tg-unpack-"));
    execFileSync("tar", ["-xzf", bundle.path, "-C", dest]);
    expect(await readFile(path.join(dest, "pipeline/terragent_pipeline/run.py"), "utf8")).toBe("print('x' * 600)\n");
    expect((await stat(path.join(dest, "pipeline/bootstrap.sh"))).mode & 0o111).not.toBe(0);
    expect((await stat(path.join(dest, "pipeline/requirements.txt"))).mode & 0o111).toBe(0);
  });

  it("is deterministic, and a content change changes the sha256 and the file's mtime", async () => {
    const root = await fakeRepo();
    const a = await buildPipelineBundle({ root });
    const b = await buildPipelineBundle({ root, out: "dist/again.tgz" });
    expect(b.sha256).toBe(a.sha256);

    const dest1 = await mkdtemp(path.join(tmpdir(), "tg-unpack-"));
    execFileSync("tar", ["-xzf", a.path, "-C", dest1]);
    await writeFile(path.join(root, "pipeline/terragent_pipeline/run.py"), "print('y' * 600)\n"); // same size
    const c = await buildPipelineBundle({ root });
    expect(c.sha256).not.toBe(a.sha256);
    const dest2 = await mkdtemp(path.join(tmpdir(), "tg-unpack-"));
    execFileSync("tar", ["-xzf", c.path, "-C", dest2]);
    const mtime = async (d: string) => (await stat(path.join(d, "pipeline/terragent_pipeline/run.py"))).mtimeMs;
    expect(await mtime(dest2)).not.toBe(await mtime(dest1)); // so Python can't reuse a stale .pyc
  });
});
