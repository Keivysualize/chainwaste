import { readFileSync } from "node:fs";
import { encodeBytes32String, getAddress, isHexString, keccak256 } from "ethers";
import { actorRoles } from "../network/settings.mjs";
import { openBesu, openRegistry } from "../scripts/experiments/besu.mjs";

const statuses = ["Created", "InTransit", "Received", "Treated"];
const txOptions = { type: 0, gasPrice: 0n };
const commands = {
  accounts: [],
  register: ["role", "address"],
  create: ["transporter-address", "processor-address", "waste-code", "kg", "document"],
  "pickup-weight": ["id", "kg", "seal-file"],
  pickup: ["id"],
  "received-weight": ["id", "kg"],
  receive: ["id"],
  treat: ["id", "proof-file"],
  flag: ["id", "reason-file"],
  resolve: ["id", "note-file"],
  show: ["id"],
  audit: ["id"],
  verify: ["id", "document"],
};

function help() {
  console.log("Usage: node cli/chainwaste.mjs <command> [arguments]\n");
  for (const [name, args] of Object.entries(commands)) {
    console.log([name, ...args.map((arg) => `<${arg}>`)].join(" "));
  }
}

function positive(value, label) {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive integer.`);
  const parsed = BigInt(value);
  if (parsed >= 2n ** 256n) throw new Error(`${label} is too large.`);
  return parsed;
}

function weight(value) {
  const kg = positive(value, "Weight");
  if (kg > 100_000n) throw new Error("Weight must be at most 100,000 kg.");
  return kg;
}

const hashFile = (path) => keccak256(readFileSync(path));
const json = (value) => console.log(JSON.stringify(value, (_, entry) =>
  typeof entry === "bigint" ? entry.toString() : entry, 2));
const [command, ...args] = process.argv.slice(2);
if (!command || command === "--help") {
  help();
  process.exit(0);
}
if (!Object.hasOwn(commands, command) || args.length !== commands[command].length) {
  help();
  process.exit(2);
}

let provider;
let registry;
try {
  const context = await openBesu();
  provider = context.provider;
  const { deployment } = context;
  const opened = await openRegistry(provider, deployment);
  registry = opened.registry;
  const sign = opened.sign;

  async function send(role, method, ...params) {
    const signer = sign(role);
    console.log(`Actor: ${role} (${signer.address})`);
    const tx = await registry.connect(signer)[method](...params, txOptions);
    console.log(`Submitted: ${tx.hash}`);
    const receipt = await tx.wait(1, 60_000);
    const events = receipt.logs.flatMap((log) => {
      const event = registry.interface.parseLog(log);
      return event ? [{ event: event.name, ...event.args.toObject() }] : [];
    });
    json({ txHash: tx.hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed, events });
  }

  const manifestId = () => positive(args[0], "Manifest ID");
  switch (command) {
    case "accounts":
      for (const [role, address] of Object.entries(deployment.accounts)) {
        const roleName = role === "regulator" ? "REGULATOR_ROLE" : actorRoles[role];
        if (roleName) {
          const active = await registry.hasRole(await registry[roleName](), address);
          console.log(`${role}: ${address} (${active ? "active" : "missing role"})`);
        }
      }
      break;
    case "register":
      if (!Object.hasOwn(actorRoles, args[0])) throw new Error("Role must be generator, transporter, processor, auditor, or oracle.");
      await send("regulator", "registerActor", getAddress(args[1]), await registry[actorRoles[args[0]]]());
      break;
    case "create":
      await send("generator", "createManifest", getAddress(args[0]), getAddress(args[1]),
        encodeBytes32String(args[2]), weight(args[3]), hashFile(args[4]));
      break;
    case "pickup-weight":
      await send("oracle", "recordPickupWeight", manifestId(), weight(args[1]), hashFile(args[2]));
      break;
    case "pickup":
      await send("transporter", "confirmPickup", manifestId());
      break;
    case "received-weight":
      await send("oracle", "recordReceivedWeight", manifestId(), weight(args[1]));
      break;
    case "receive":
      await send("processor", "confirmReceipt", manifestId());
      break;
    case "treat":
      await send("processor", "markTreated", manifestId(), hashFile(args[1]));
      break;
    case "flag":
      await send("auditor", "flagManually", manifestId(), hashFile(args[1]));
      break;
    case "resolve":
      await send("auditor", "resolveFlag", manifestId(), hashFile(args[1]));
      break;
    case "show": {
      const item = await registry.getManifest(manifestId());
      json({ id: manifestId(), ...item.toObject(), status: statuses[Number(item.status)] });
      break;
    }
    case "verify": {
      const item = await registry.getManifest(manifestId());
      const actual = hashFile(args[1]);
      const matches = item.docHash === actual;
      json({ matches, expected: item.docHash, actual });
      if (!matches) process.exitCode = 1;
      break;
    }
    case "audit": {
      const id = manifestId();
      await registry.getManifest(id);
      const fragments = registry.interface.fragments.filter((entry) =>
        entry.type === "event" && entry.inputs[0]?.name === "id" && entry.inputs[0].indexed);
      const topics = fragments.map((event) => event.topicHash);
      const address = await registry.getAddress();
      const latest = Number(await provider.send("eth_blockNumber", []));
      const manifestTopic = "0x" + id.toString(16).padStart(64, "0");
      const rows = [];
      for (let fromBlock = 0; fromBlock <= latest; fromBlock += 1_000) {
        const logs = await provider.getLogs({
          address, topics: [topics, manifestTopic], fromBlock, toBlock: Math.min(fromBlock + 999, latest),
        });
        for (const log of logs) {
          const event = registry.interface.parseLog(log);
          const [tx, block] = await Promise.all([log.getTransaction(), log.getBlock()]);
          rows.push({
            event: event.name, args: event.args.toObject(), actor: tx.from,
            block: log.blockNumber, logIndex: log.index, txHash: log.transactionHash,
            timestamp: new Date(block.timestamp * 1_000).toISOString(),
          });
        }
      }
      json(rows.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex));
      break;
    }
  }
} catch (error) {
  const code = error.data ?? error.info?.error?.data;
  const decoded = registry && typeof code === "string" && isHexString(code)
    ? registry.interface.parseError(code) : null;
  const messages = {
    AccessControlUnauthorizedAccount: "The account does not have the required role.",
    WrongActor: "This account is not assigned to the manifest.",
    WrongStatus: "The manifest is at the wrong stage for this action.",
    FlagStillOpen: "The auditor must resolve the flag before processing can continue.",
    FlagNotOpen: "The manifest has no open flag.",
    WeightMissing: "Record the weight with the oracle before confirming.",
    WeightAlreadyRecorded: "The weight for this stage was already recorded.",
    UnknownManifest: "The manifest ID does not exist.",
    InvalidInput: "The contract rejected an invalid input.",
  };
  console.error(decoded ? `${decoded.name}: ${messages[decoded.name] ?? "Contract rejected the action."}`
    : error.shortMessage ?? error.message);
  process.exitCode = 1;
} finally {
  provider?.destroy();
}
