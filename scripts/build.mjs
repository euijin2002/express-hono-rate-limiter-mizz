#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const localEsbuild = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");
const workspaceEsbuild = path.resolve(root, "../../../../node_modules/.bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");
const esbuild = fs.existsSync(localEsbuild) ? localEsbuild : workspaceEsbuild;

if (!fs.existsSync(esbuild)) {
  console.error("esbuild not found. Run `npm install` first.");
  process.exit(1);
}

const builds = [
  ["src/index.ts", "--bundle", "--platform=node", "--format=esm", "--outfile=dist/index.js"],
  ["src/index.ts", "--bundle", "--platform=node", "--format=cjs", "--outfile=dist/index.cjs"],
];

for (const args of builds) {
  const result = spawnSync(esbuild, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
