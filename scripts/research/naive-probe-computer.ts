/**
 * Probe an agent's Naïve computer (OS, Python, pip/venv/uv, disk, egress) with read-only commands, so
 * the imagery pipeline's bootstrap can be written against facts. The computer exists only after one of
 * the agent's sessions has used a shell tool (scripts/research/naive-smoke.ts does that for tg-smoke).
 *
 *   npx tsx scripts/research/naive-probe-computer.ts --agent tg-smoke [--json]
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { naive } from "../../src/lib/naive/client";

const { values } = parseArgs({
  options: { agent: { type: "string", default: "tg-smoke" }, json: { type: "boolean", default: false } },
});

const URLS = [
  "https://planetarycomputer.microsoft.com/api/stac/v1",
  "https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel-2-l2a",
  "https://pypi.org/simple/rasterio/",
  "https://files.pythonhosted.org/",
  "https://github.com/",
  "https://astral.sh/uv/install.sh",
  "https://api.weather.gov/alerts/active?limit=1",
];

const CHECKS: { name: string; cmd: string; timeoutMs?: number }[] = [
  { name: "os", cmd: "head -4 /etc/os-release; uname -srm" },
  { name: "python", cmd: "python3 --version; python3 -c 'import sys; print(sys.executable)'; ls /usr/bin/python3* /usr/local/bin/python3* 2>/dev/null" },
  {
    name: "pip_venv",
    cmd:
      "python3 -m pip --version 2>&1 | head -1; " +
      "(python3 -m venv --help >/dev/null 2>&1 && echo venv-module-ok) || echo venv-module-missing; " +
      "ls /usr/lib/python3*/EXTERNALLY-MANAGED 2>/dev/null || echo not-externally-managed",
  },
  { name: "tools", cmd: "for t in uv uvx pip pip3 curl wget git tar gzip gcc gdal-config apt-get; do printf '%s: ' $t; command -v $t || echo missing; done" },
  { name: "resources", cmd: "nproc; free -m | head -2; df -h \"$HOME\" /tmp; echo HOME=$HOME; pwd; whoami; (sudo -n true 2>/dev/null && echo sudo-ok) || echo no-sudo" },
  {
    name: "egress",
    cmd: URLS.map((u) => `printf '%s ' '${u}'; curl -sS -o /dev/null -m 15 -w '%{http_code} %{time_total}s\\n' '${u}' || echo FAIL`).join("; "),
    timeoutMs: 120_000,
  },
  { name: "pip_index", cmd: "python3 -m pip index versions rasterio 2>&1 | head -2; python3 -m pip index versions numpy 2>&1 | head -1", timeoutMs: 90_000 },
];

const client = naive();
const agents = await client.agents.list({ limit: 100 });
const agent = agents.data.find((a) => a.name === values.agent || a.id === values.agent);
if (!agent) throw new Error(`no agent named ${values.agent}`);
const computer = await client.agents.computer(agent.id);
if (!computer) throw new Error(`${values.agent} has no computer yet: run one session that uses bash first (scripts/research/naive-smoke.ts)`);

const results = [];
for (const c of CHECKS) {
  const t0 = Date.now();
  try {
    const r = await client.computers.exec(computer.id, c.cmd, c.timeoutMs ?? 60_000);
    results.push({ name: c.name, exit_code: r.exit_code, stdout: r.stdout.slice(0, 3000), stderr: r.stderr.slice(0, 800), ms: Date.now() - t0 });
  } catch (e) {
    results.push({ name: c.name, error: (e as Error).message, ms: Date.now() - t0 });
  }
}
await client.computers.pause(computer.id).catch(() => undefined); // agent computers may refuse (409) while in use

const report = { agent: agent.name, computer: { id: computer.id, vcpu: computer.vcpu, memory_mb: computer.memory_mb, disk_gb: computer.disk_gb, status: computer.status }, results };
if (values.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`[probe] ${agent.name} computer ${computer.id} (${computer.vcpu} vCPU, ${computer.memory_mb} MB, ${computer.disk_gb} GB)`);
  for (const r of results) console.log(`\n## ${r.name} (${r.ms} ms)\n${"error" in r ? `ERROR ${r.error}` : `${r.stdout}${r.stderr ? `\n[stderr] ${r.stderr}` : ""}`}`);
}
