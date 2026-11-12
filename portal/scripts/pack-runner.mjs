#!/usr/bin/env node
/** Pack runner/ into dist/hwcloud-grow-runner.zip (excludes node_modules) */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const portalRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(portalRoot, "..");
const runnerDir = join(repoRoot, "runner");
const distDir = join(portalRoot, "dist");
const zipPath = join(distDir, "hwcloud-grow-runner.zip");
const staging = join(distDir, ".runner-staging");

const SKIP = new Set(["node_modules", ".runner-staging"]);

function copyRunner(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    if (SKIP.has(name)) continue;
    const from = join(src, name);
    const to = join(dest, name);
    if (statSync(from).isDirectory()) {
      copyRunner(from, to);
    } else {
      cpSync(from, to);
    }
  }
}

if (!existsSync(runnerDir)) {
  console.error("missing runner/ directory");
  process.exit(1);
}

mkdirSync(distDir, { recursive: true });
rmSync(staging, { recursive: true, force: true });
const bundleRoot = join(staging, "hwcloud-grow-runner");
copyRunner(runnerDir, bundleRoot);
rmSync(zipPath, { force: true });

if (process.platform === "win32") {
  const ps = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${join(staging, "hwcloud-grow-runner").replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: "inherit" },
  );
  if (ps.status !== 0) process.exit(ps.status || 1);
} else {
  const zip = spawnSync("zip", ["-r", zipPath, "hwcloud-grow-runner"], {
    cwd: staging,
    stdio: "inherit",
  });
  if (zip.status !== 0) process.exit(zip.status || 1);
}

rmSync(staging, { recursive: true, force: true });
console.log(`Packed ${zipPath}`);
