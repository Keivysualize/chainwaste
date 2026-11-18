import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Contract, ContractFactory, decodeRlp, encodeBytes32String, FetchRequest, id, JsonRpcProvider, Wallet } from "ethers";
import { actorRoles, chainId, rpcUrl, validators } from "./settings.mjs";

const generated = new URL("./generated/", import.meta.url);
const deploymentFile = new URL("deployment.json", generated);
const pendingFile = new URL("deployment.pending.json", generated);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const accounts = readJson(new URL("accounts.json", generated));
const genesis = readJson(new URL("genesis.json", generated));
const request = new FetchRequest(rpcUrl);
request.timeout = 5_000;
const provider = new JsonRpcProvider(request, undefined, { batchMaxCount: 1 });
const regulator = new Wallet(accounts.regulator.privateKey, provider);
const txOptions = { gasPrice: 0n, type: 0 };

async function waitForNetwork() {
  const expected = decodeRlp(genesis.extraData)[1];
  let initialBlock;
  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const network = await provider.getNetwork();
      if (network.chainId !== BigInt(chainId)) {
        throw new Error(`Wrong chain ID on ${rpcUrl}: expected ${chainId}, got ${network.chainId}.`);
      }
      const actual = await provider.send("qbft_getValidatorsByBlockNumber", ["latest"]);
      if (JSON.stringify(actual.map((address) => address.toLowerCase()).sort()) !== JSON.stringify(expected)) {
        throw new Error("QBFT validator set differs from the generated genesis.");
      }
      const height = Number(await provider.send("eth_blockNumber", []));
      initialBlock ??= height;
      if (height > initialBlock) return height;
    } catch (error) {
      lastError = error.message;
    }
    await delay(2_000);
  }
  throw new Error(`Besu did not produce a new block with the expected validator set. ${lastError ?? ""}`);
}

function saveDeployment(deployment) {
  writeFileSync(pendingFile, JSON.stringify(deployment, null, 2) + "\n");
  renameSync(pendingFile, deploymentFile);
}

async function deployOrLoad(name, args, deployment) {
  const artifact = readJson(new URL(`../artifacts/contracts/${name}.sol/${name}.json`, import.meta.url));
  const existing = deployment.contracts[name];
  if (existing) {
    if (await provider.getCode(existing) === "0x") throw new Error(`No code at saved ${name} address ${existing}.`);
    return new Contract(existing, artifact.abi, regulator);
  }
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, regulator).deploy(...args, txOptions);
  const receipt = await contract.deploymentTransaction().wait(1, 60_000);
  deployment.contracts[name] = await contract.getAddress();
  saveDeployment(deployment);
  console.log(`${name}: ${deployment.contracts[name]} (gas used ${receipt.gasUsed})`);
  return contract;
}

try {
  const height = await waitForNetwork();
  const genesisHash = (await provider.getBlock(0)).hash;
  const deployment = existsSync(deploymentFile) ? readJson(deploymentFile) : {
    rpcUrl, chainId, genesisHash, contracts: {}, accounts: {},
  };
  if (deployment.genesisHash !== genesisHash) {
    throw new Error("Saved deployment belongs to a different genesis.");
  }
  console.log(`QBFT ready: 7 validators, block ${height}, chain ID ${chainId}.`);
  const registry = await deployOrLoad("ChainWasteRegistry", [regulator.address], deployment);
  await deployOrLoad("ValidatorGovernance", [
    validators.map(({ name }) => accounts[name].address),
    validators.map(({ sector }) => sector),
  ], deployment);

  for (const [actor, name] of Object.entries(actorRoles)) {
    const role = await registry[name]();
    if (!await registry.hasRole(role, accounts[actor].address)) {
      const tx = await registry.registerActor(accounts[actor].address, role, txOptions);
      await tx.wait(1, 60_000);
    }
  }
  deployment.accounts = Object.fromEntries(Object.entries(accounts).map(([name, { address }]) => [name, address]));

  const demoHash = id("chainwaste-demo-manifest-v1");
  const generator = new Wallet(accounts.generator.privateKey, provider);
  const generatorManifests = await registry.getManifestsByGenerator(generator.address);
  let demoId;
  for (const manifestId of generatorManifests) {
    if ((await registry.getManifest(manifestId)).docHash === demoHash) {
      demoId = manifestId;
      break;
    }
  }
  if (demoId === undefined) {
    const tx = await registry.connect(generator).createManifest(
      accounts.transporter.address, accounts.processor.address,
      encodeBytes32String("B3-DEMO"), 10_000, demoHash, txOptions,
    );
    const receipt = await tx.wait(1, 60_000);
    const created = receipt.logs.map((log) => registry.interface.parseLog(log))
      .find((event) => event?.name === "ManifestCreated");
    if (!created) throw new Error("ManifestCreated event missing from seed receipt.");
    demoId = created.args.id;
  }
  deployment.demoManifestId = demoId.toString();
  saveDeployment(deployment);
  console.log(`Demo manifest #${demoId}. RPC and contract addresses: network/generated/deployment.json`);
} finally {
  provider.destroy();
}
