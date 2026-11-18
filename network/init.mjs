import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeRlp, toBeHex, Wallet, ZeroAddress, ZeroHash } from "ethers";
import { actorRoles, chainId, image, subnet, validators } from "./settings.mjs";

const generated = fileURLToPath(new URL("./generated", import.meta.url));
if (existsSync(generated)) {
  console.log("Using existing network/generated. Keys and genesis are preserved.");
  process.exit(0);
}
const staging = mkdtempSync(join(generated, "..", "generated-"));
const save = (path, value) => writeFileSync(join(staging, path), JSON.stringify(value, null, 2) + "\n");
try {
  const nodes = [...validators, { name: "rpc" }].map((node, index) => {
    const key = Wallet.createRandom();
    const ip = `${subnet}.${index + 11}`;
    return { ...node, key, ip, enode: `enode://${key.signingKey.publicKey.slice(4)}@${ip}:30303` };
  });
  const roles = ["regulator", ...Object.keys(actorRoles), ...validators.map(({ name }) => name)];
  const accounts = Object.fromEntries(roles.map((role) => {
    const { address, privateKey } = Wallet.createRandom();
    return [role, { address, privateKey }];
  }));
  mkdirSync(join(staging, "nodes"));
  save("accounts.json", accounts);
  const validatorAddresses = nodes.slice(0, validators.length).map(({ key }) => key.address.toLowerCase()).sort();
  const alloc = Object.fromEntries(Object.values(accounts).map(({ address }) =>
    [address.slice(2).toLowerCase(), { balance: toBeHex(100n * 10n ** 18n) }]));
  save("genesis.json", {
    config: {
      chainid: chainId,
      berlinBlock: 0,
      londonBlock: 0,
      zeroBaseFee: true,
      qbft: { blockperiodseconds: 2, epochlength: 30000, requesttimeoutseconds: 4 },
    },
    nonce: "0x0",
    timestamp: "0x0",
    extraData: encodeRlp([ZeroHash, validatorAddresses, [], "0x", []]),
    gasLimit: "0x1c9c380",
    difficulty: "0x1",
    mixHash: "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365",
    coinbase: ZeroAddress,
    alloc,
  });
  const services = {};
  const volumes = {};
  for (const node of nodes) {
    const { name, ip, key } = node;
    mkdirSync(join(staging, "nodes", name));
    writeFileSync(join(staging, "nodes", name, "key"), key.privateKey.slice(2));
    save(`nodes/${name}/static-nodes.json`, nodes.filter((peer) => peer !== node).map(({ enode }) => enode));
    const isRpc = name === "rpc";
    services[name] = {
      image,
      entrypoint: ["/bin/sh", "-c", 'chown 1000:1000 /data && exec besu-entry.sh "$@"', "besu"],
      environment: { JAVA_OPTS: "-Xms128m -Xmx384m" },
      command: [
        "--data-path=/data",
        "--genesis-file=/config/genesis.json",
        "--node-private-key-file=/node/key",
        "--static-nodes-file=/node/static-nodes.json",
        "--discovery-enabled=false",
        "--nat-method=NONE",
        `--p2p-host=${ip}`,
        "--sync-mode=FULL",
        "--min-gas-price=0",
        ...(isRpc ? [
          "--rpc-http-enabled=true", "--rpc-http-host=0.0.0.0",
          "--host-allowlist=localhost,127.0.0.1", "--rpc-http-api=ETH,NET,WEB3,QBFT",
        ] : []),
      ],
      volumes: [
        "./genesis.json:/config/genesis.json:ro",
        `./nodes/${name}:/node:ro`,
        `${name}-data:/data`,
      ],
      networks: { qbft: { ipv4_address: ip } },
      ...(isRpc ? { ports: ["127.0.0.1:8545:8545"] } : {}),
    };
    volumes[`${name}-data`] = {};
  }
  save("compose.json", {
    name: "chainwaste-qbft",
    services,
    volumes,
    networks: { qbft: { ipam: { config: [{ subnet: `${subnet}.0/24` }] } } },
  });
  renameSync(staging, generated);
  console.log("Generated seven unique validators and one RPC node in network/generated.");
} finally {
  rmSync(staging, { recursive: true, force: true });
}
