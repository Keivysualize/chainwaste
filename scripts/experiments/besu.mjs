import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Contract, FetchRequest, JsonRpcProvider, Wallet } from "ethers";

const generated = new URL("../../network/generated/", import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

export async function openBesu() {
  const deployment = readJson(new URL("deployment.json", generated));
  const request = new FetchRequest(deployment.rpcUrl);
  request.timeout = 5_000;
  const provider = new JsonRpcProvider(request, undefined, { batchMaxCount: 1 });
  try {
    const chainId = Number(await provider.send("eth_chainId", []));
    const genesis = await provider.getBlock(0);
    if (chainId !== deployment.chainId || genesis?.hash !== deployment.genesisHash) {
      throw new Error("RPC does not match the saved ChainWaste deployment.");
    }
    return { provider, deployment };
  } catch (error) {
    provider.destroy();
    throw error;
  }
}

export async function openRegistry(provider, deployment) {
  const accounts = readJson(new URL("accounts.json", generated));
  const sign = (role) => new Wallet(accounts[role].privateKey, provider);
  const artifact = readJson(new URL(
    "../../artifacts/contracts/ChainWasteRegistry.sol/ChainWasteRegistry.json", import.meta.url,
  ));
  const address = deployment.contracts.ChainWasteRegistry;
  if (await provider.getCode(address) === "0x") throw new Error("Registry bytecode is missing.");
  return { registry: new Contract(address, artifact.abi, provider), sign };
}

export function saveReport(name, report) {
  const reports = new URL("experiments/", generated);
  mkdirSync(reports, { recursive: true });
  const path = `${name}-${new Date().toISOString().replaceAll(":", "-")}.json`;
  writeFileSync(new URL(path, reports), JSON.stringify(report, null, 2) + "\n");
  console.log(`Report: network/generated/experiments/${path}`);
}
