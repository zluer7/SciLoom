import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const developmentRoot = fileURLToPath(new URL("../", import.meta.url));
const projectRoot = path.dirname(developmentRoot.replace(/[\\/]$/, ""));
const devEnvRoot = path.join(projectRoot, "DevEnv");
const hasProjectDevEnv = existsSync(path.join(devEnvRoot, "Cargo", "bin"))
  && existsSync(path.join(devEnvRoot, "Rustup"));
const environment = {
  ...process.env,
  SCILOOM_DEV_RUNTIME_ROOT: process.env.SCILOOM_DEV_RUNTIME_ROOT
    ?? (hasProjectDevEnv ? path.join(projectRoot, "AppData") : path.join(developmentRoot, ".tmp", "dev-runtime")),
};
if (process.platform === "win32" && hasProjectDevEnv) {
  const cargoBin = path.join(devEnvRoot, "Cargo", "bin");
  const existingPath = environment.Path ?? environment.PATH ?? "";
  delete environment.PATH;
  environment.Path = [cargoBin, ...existingPath.split(";").filter((entry) =>
    entry && entry.replace(/[\\/]$/, "").toLowerCase() !== cargoBin.toLowerCase()
  )].join(";");
  environment.CARGO_HOME = path.join(devEnvRoot, "Cargo");
  environment.RUSTUP_HOME = path.join(devEnvRoot, "Rustup");
  environment.CARGO_TARGET_DIR = path.join(devEnvRoot, "Build-Cache", "SciLoom-Cargo-Target");
  environment.npm_config_cache = path.join(devEnvRoot, "npm-cache");
  environment.TEMP = environment.TMP = path.join(devEnvRoot, "Temp");
}

const cli = path.join(developmentRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
const child = spawn(process.execPath, [cli, "dev", ...process.argv.slice(2)], {
  cwd: developmentRoot,
  env: environment,
  stdio: "inherit",
});
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
