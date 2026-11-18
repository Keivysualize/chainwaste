import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import "./init.mjs";

const compose = fileURLToPath(new URL("./generated/compose.json", import.meta.url));
const { error, status } = spawnSync("docker", ["compose", "-f", compose, "up", "-d"], {
  stdio: "inherit",
});
if (error) throw error;
process.exitCode = status ?? 1;
