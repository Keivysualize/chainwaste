import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { validators } from "../../network/settings.mjs";
import { openBesu, saveReport } from "./besu.mjs";

const composeFile = fileURLToPath(new URL("../../network/generated/compose.json", import.meta.url));
const names = validators.map(({ name }) => name);
const targets = names.slice(0, 3);
function compose(...args) {
  const result = spawnSync("docker", ["compose", "-f", composeFile, ...args], {
    encoding: "utf8", timeout: 90_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Docker exited with ${result.status}.`);
  return result.stdout.trim();
}

function requireRunning(expected) {
  const running = new Set(compose("ps", "--status", "running", "--services").split(/\r?\n/));
  if (!running.has("rpc") || names.some((name) => running.has(name) !== expected.includes(name))) {
    throw new Error(`Unexpected running services: ${[...running].join(", ")}`);
  }
}

requireRunning(names);
const { provider, deployment } = await openBesu();
const block = async () => Number(await provider.send("eth_blockNumber", []));
const samples = [];
const stopped = [];

async function observe(label, stoppedCount, windowMs, expectProgress) {
  const start = await block();
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + windowMs;
  let end = start;
  do {
    await delay(Math.min(1_000, Math.max(0, deadline - Date.now())));
    end = await block();
  } while (Date.now() < deadline && !(expectProgress && end > start));
  const passed = expectProgress ? end > start : end === start;
  samples.push({ label, stoppedCount, startedAt, endedAt: new Date().toISOString(), start, end, passed });
  console.log(`${label}: block ${start} -> ${end} (${passed ? "PASS" : "FAIL"})`);
  if (!passed) throw new Error(`Unexpected QBFT behavior: ${label}.`);
}

try {
  await observe("All validators running", 0, 15_000, true);
  try {
    for (let index = 0; index < targets.length; index++) {
      stopped.push(targets[index]);
      compose("stop", targets[index]);
      requireRunning(names.filter((name) => !stopped.includes(name)));
      if (stopped.length === 3) await delay(6_000);
      await observe(`${stopped.length} validator(s) stopped`, stopped.length, 25_000, stopped.length < 3);
    }
  } finally {
    if (stopped.length) compose("start", ...stopped);
  }
  requireRunning(names);
  await observe("Recovery", 0, 90_000, true);
} finally {
  provider.destroy();
  saveReport("quorum", { chainId: deployment.chainId, genesisHash: deployment.genesisHash, targets, samples });
}
