export const chainId = 31370;
export const rpcUrl = "http://127.0.0.1:8545";
export const subnet = "172.30.74";
export const image = "hyperledger/besu:26.2.0";

export const validators = [
  { name: "val-regulator", sector: 0 },
  { name: "val-gakkum", sector: 1 },
  { name: "val-industri", sector: 2 },
  { name: "val-pengolah-a", sector: 3 },
  { name: "val-pengolah-b", sector: 3 },
  { name: "val-auditor", sector: 4 },
  { name: "val-universitas", sector: 5 },
];
export const actorRoles = {
  generator: "GENERATOR_ROLE",
  transporter: "TRANSPORTER_ROLE",
  processor: "PROCESSOR_ROLE",
  auditor: "AUDITOR_ROLE",
  oracle: "IOT_ORACLE_ROLE",
};
