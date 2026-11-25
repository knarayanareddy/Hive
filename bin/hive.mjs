#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(__dirname, "../src/cli/hive.ts");

const r = spawnSync(
  process.execPath,
  ["--no-warnings", "--import", "tsx", cliEntry, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(r.status ?? 1);
