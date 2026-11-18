import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { encodeBytes32String, getAddress, isHexString, keccak256 } from "ethers";
import { openBesu, openRegistry } from "../scripts/experiments/besu.mjs";
import { actorRoles } from "../network/settings.mjs";

const host = "127.0.0.1";
const port = 4173;
const origin = `http://${host}:${port}`;
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
].map(([route, [file, type]]) => [route, [readFileSync(new URL(`./public/${file}`, import.meta.url)), type]]));
const methods = {
  register: ["regulator", "registerActor"],
  create: ["generator", "createManifest"],
  "pickup-weight": ["oracle", "recordPickupWeight"],
  pickup: ["transporter", "confirmPickup"],
  "received-weight": ["oracle", "recordReceivedWeight"],
  receive: ["processor", "confirmReceipt"],
  treat: ["processor", "markTreated"],
  resolve: ["auditor", "resolveFlag"],
};
const statuses = ["Created", "InTransit", "Received", "Treated"];
const { provider, deployment } = await openBesu();
const { registry, sign } = await openRegistry(provider, deployment);
const actors = Object.fromEntries(Object.entries(deployment.accounts)
  .filter(([role]) => role === "regulator" || Object.hasOwn(actorRoles, role)));
const txOptions = { type: 0, gasPrice: 0n };
let processing = false;

class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const json = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, (_, entry) => typeof entry === "bigint" ? entry.toString() : entry));
};

async function body(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new RequestError("Gunakan JSON.", 415);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length <= 1_450_000) chunks.push(chunk);
  }
  if (length > 1_450_000) throw new RequestError("Permintaan terlalu besar.", 413);
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new RequestError("JSON tidak valid.");
  }
}

function positive(value, label, max = 2n ** 256n - 1n) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,77}$/.test(value) || BigInt(value) > max) {
    throw new RequestError(`${label} tidak valid.`);
  }
  return BigInt(value);
}

function fileHash(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9+/]*={0,2}$/.test(value) || value.length % 4) {
    throw new RequestError("File tidak valid.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > 1_048_576) throw new RequestError("Batas file 1 MiB.", 413);
  return keccak256(bytes);
}

function address(value) {
  try { return getAddress(value); } catch { throw new RequestError("Alamat wallet tidak valid."); }
}
function manifestView(id, item) {
  return { id, ...item.toObject(), status: statuses[Number(item.status)] };
}

async function write(action, input) {
  if (!Object.hasOwn(methods, action)) throw new RequestError("Aksi tidak dikenal.", 404);
  const [role, method] = methods[action];
  if (input.role !== role) throw new RequestError(`Gunakan akun ${role} untuk aksi ini.`, 403);
  let args;
  const kg = () => positive(input.kg, "Berat (kg)", 100_000n);
  const id = () => positive(input.id, "ID manifest");
  switch (action) {
    case "register":
      if (!Object.hasOwn(actorRoles, input.targetRole)) throw new RequestError("Peran tujuan tidak valid.");
      args = [address(input.address), await registry[actorRoles[input.targetRole]]()];
      break;
    case "create": {
      let code;
      try {
        if (typeof input.wasteCode !== "string" || !input.wasteCode.trim()) throw new Error();
        code = encodeBytes32String(input.wasteCode.trim());
      } catch { throw new RequestError("Kode limbah wajib diisi, maksimal 31 byte."); }
      args = [address(input.transporter), address(input.processor), code, kg(), fileHash(input.file)];
      break;
    }
    case "pickup-weight": args = [id(), kg(), fileHash(input.file)]; break;
    case "received-weight": args = [id(), kg()]; break;
    case "treat":
    case "resolve": args = [id(), fileHash(input.file)]; break;
    default: args = [id()];
  }
  if (processing) throw new RequestError("Tunggu transaksi sebelumnya selesai.", 409);
  processing = true;
  try {
    const signer = sign(role);
    const nonce = Number(await provider.send("eth_getTransactionCount", [signer.address, "pending"]));
    const transaction = await registry[method].populateTransaction(...args);
    const gas = BigInt(await provider.send("eth_estimateGas", [{
      from: signer.address, to: transaction.to, data: transaction.data, gasPrice: "0x0",
    }]));
    const tx = await signer.sendTransaction({ ...transaction, ...txOptions, nonce, gasLimit: gas });
    let receipt;
    try { receipt = await tx.wait(1, 60_000); } catch (error) {
      if (error.code === "TIMEOUT") throw new RequestError(`Receipt belum tersedia. Cek transaksi ${tx.hash} sebelum mengulang.`, 504);
      throw error;
    }
    const events = receipt.logs.flatMap((log) => {
      const event = registry.interface.parseLog(log);
      return event ? [{ name: event.name, args: event.args.toObject() }] : [];
    });
    return { hash: tx.hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed,
      id: events.find(({ name }) => name === "ManifestCreated")?.args.id ?? input.id, events };
  } finally {
    processing = false;
  }
}

async function audit(id) {
  await registry.getManifest(id);
  const latest = Number(await provider.send("eth_blockNumber", []));
  const topics = registry.interface.fragments.filter((entry) =>
    entry.type === "event" && entry.inputs[0]?.indexed && entry.inputs[0]?.name === "id")
    .map((entry) => entry.topicHash);
  const rows = [];
  const blockCache = new Map();
  for (let fromBlock = 0; fromBlock <= latest; fromBlock += 1_000) {
    const logs = await provider.getLogs({
      address: await registry.getAddress(), topics: [topics, "0x" + id.toString(16).padStart(64, "0")],
      fromBlock, toBlock: Math.min(fromBlock + 999, latest),
    });
    for (const log of logs) {
      const event = registry.interface.parseLog(log);
      if (!blockCache.has(log.blockNumber)) blockCache.set(log.blockNumber, log.getBlock());
      const [block, tx] = await Promise.all([blockCache.get(log.blockNumber), log.getTransaction()]);
      rows.push({ name: event.name, block: log.blockNumber, index: log.index, hash: log.transactionHash,
        actor: tx.from, at: new Date(block.timestamp * 1000).toISOString() });
    }
  }
  return rows.sort((a, b) => b.block - a.block || b.index - a.index);
}

function reportError(res, error) {
  if (error instanceof RequestError) return json(res, error.status, { error: error.message });
  const data = error.data ?? error.info?.error?.data;
  const decoded = typeof data === "string" && isHexString(data) && data.length >= 10
    ? registry.interface.parseError(data) : null;
  if (decoded) {
    const descriptions = {
      FlagStillOpen: "Auditor perlu menyelesaikan flag sebelum pengolahan.",
      WrongActor: "Akun ini bukan aktor yang ditugaskan.",
      WrongStatus: "Status manifest tidak sesuai untuk aksi ini.",
      WeightMissing: "Catat berat melalui oracle terlebih dahulu.",
      WeightAlreadyRecorded: "Berat tahap ini sudah tercatat.",
      FlagNotOpen: "Manifest tidak memiliki flag terbuka.",
      UnknownManifest: "Manifest tidak ditemukan.",
      AccessControlUnauthorizedAccount: "Akun tidak memiliki hak akses untuk aksi ini.",
      InvalidInput: "Kontrak menolak data yang diberikan.",
    };
    return json(res, 409, { error: descriptions[decoded.name] ?? "Kontrak menolak aksi.", code: decoded.name });
  }
  console.error(error.code ?? error.name);
  return json(res, 502, { error: "Operasi gagal saat berkomunikasi dengan Besu. Cek status jaringan." });
}

const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    if (req.headers.host !== `${host}:${port}`) throw new RequestError("Host tidak diizinkan.", 403);
    const path = new URL(req.url, origin).pathname;
    if (req.method === "GET" && assets.has(path)) {
      const [content, type] = assets.get(path);
      res.writeHead(200, { "Content-Type": type });
      return res.end(content);
    }
    if (req.method === "POST" && req.headers.origin !== origin) {
      throw new RequestError("Origin tidak diizinkan.", 403);
    }
    if (req.method === "GET" && path === "/api/state") {
      const [height, validators, count] = await Promise.all([
        provider.send("eth_blockNumber", []),
        provider.send("qbft_getValidatorsByBlockNumber", ["latest"]),
        registry.manifestCount(),
      ]);
      return json(res, 200, { height: Number(height), validators, count, chainId: deployment.chainId, actors });
    }
    const match = /^\/api\/manifests\/([1-9][0-9]{0,77})(\/audit)?$/.exec(path);
    if (req.method === "GET" && match) {
      const id = positive(match[1], "ID manifest");
      const value = match[2] ? await audit(id) : manifestView(id, await registry.getManifest(id));
      return json(res, 200, value);
    }
    if (req.method === "POST" && path === "/api/verify") {
      const input = await body(req);
      const item = await registry.getManifest(positive(input.id, "ID manifest"));
      const actual = fileHash(input.file);
      return json(res, 200, { matches: actual === item.docHash, actual, expected: item.docHash });
    }
    const operation = /^\/api\/actions\/([a-z-]+)$/.exec(path);
    if (req.method === "POST" && operation) return json(res, 200, await write(operation[1], await body(req)));
    return json(res, 404, { error: "Halaman tidak ditemukan." });
  } catch (error) {
    reportError(res, error);
  }
});
server.listen(port, host, () => console.log(`ChainWaste dashboard: ${origin}`));
server.on("close", () => provider.destroy());
