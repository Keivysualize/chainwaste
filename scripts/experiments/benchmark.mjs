import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { encodeBytes32String, id } from "ethers";
import { openBesu, openRegistry, saveReport } from "./besu.mjs";

const runs = Number(process.argv[2] ?? 5);
if (!Number.isInteger(runs) || runs < 1 || runs > 50) throw new Error("Use 1-50 manifests.");
const { provider, deployment } = await openBesu();
const samples = [];
const label = randomUUID();
const startedAt = new Date().toISOString();
const options = { type: 0, gasPrice: 0n };

async function measure(operation, run, send) {
  const start = performance.now();
  const tx = await send();
  const receipt = await tx.wait(1, 60_000);
  samples.push({
    run, operation, txHash: tx.hash, block: receipt.blockNumber,
    gasUsed: Number(receipt.gasUsed), feeWei: receipt.fee.toString(),
    receiptMs: Math.round(performance.now() - start),
  });
  return receipt;
}

let completed = 0;
try {
  const { registry, sign } = await openRegistry(provider, deployment);
  const generator = sign("generator");
  const transporter = sign("transporter");
  const processor = sign("processor");
  const oracle = sign("oracle");
  for (let run = 1; run <= runs; run++) {
    const receipt = await measure("createManifest", run, () => registry.connect(generator).createManifest(
      transporter.address, processor.address, encodeBytes32String("B3-DEMO"), 10_000,
      id(`${label}/document/${run}`), options,
    ));
    const created = receipt.logs.map((log) => registry.interface.parseLog(log))
      .find((event) => event?.name === "ManifestCreated");
    if (!created) throw new Error("ManifestCreated missing from receipt.");
    const manifest = created.args.id;
    await measure("recordPickupWeight", run, () => registry.connect(oracle).recordPickupWeight(
      manifest, 10_000, id(`${label}/seal/${run}`), options,
    ));
    await measure("confirmPickup", run, () => registry.connect(transporter).confirmPickup(manifest, options));
    await measure("recordReceivedWeight", run, () => registry.connect(oracle).recordReceivedWeight(
      manifest, 9_800, options,
    ));
    await measure("confirmReceipt", run, () => registry.connect(processor).confirmReceipt(manifest, options));
    await measure("markTreated", run, () => registry.connect(processor).markTreated(
      manifest, id(`${label}/proof/${run}`), options,
    ));
    const item = await registry.getManifest(manifest);
    if (item.status !== 3n || item.flagged) throw new Error(`Manifest ${manifest} did not reach Treated.`);
    completed++;
    console.log(`Run ${run}/${runs}: manifest #${manifest} reached Treated.`);
  }
} finally {
  provider.destroy();
  const summary = Object.fromEntries([...new Set(samples.map(({ operation }) => operation))].map((operation) => {
    const rows = samples.filter((sample) => sample.operation === operation);
    const stats = (field) => {
      const values = rows.map((row) => row[field]);
      return { min: Math.min(...values), avg: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
        max: Math.max(...values) };
    };
    return [operation, { count: rows.length, gasUsed: stats("gasUsed"), receiptMs: stats("receiptMs") }];
  }));
  saveReport("benchmark", {
    startedAt, chainId: deployment.chainId, genesisHash: deployment.genesisHash,
    requestedManifests: runs, completedManifests: completed, summary, samples,
  });
}
