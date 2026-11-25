import fs from "node:fs";
import path from "node:path";
import { HiveStore } from "../kernel/db";
import { HiveKernel } from "../kernel/authority";
import { DEFAULT_TENANT, seedWorkspace } from "../kernel/seed";
import { executeHiveCli } from "./parser";

const dbPath =
  process.env.HIVE_DB_PATH ?? path.resolve(process.cwd(), ".hive/hive.db");
const jarPath =
  process.env.HIVE_TOKEN_JAR ?? path.resolve(process.cwd(), ".hive/tokens.json");
const tenantId = process.env.HIVE_TENANT ?? DEFAULT_TENANT;
const actor = process.env.HIVE_ACTOR ?? "ana";

const store = new HiveStore(dbPath);
const kernel = new HiveKernel(store);
seedWorkspace(kernel, tenantId);

let tokenJar: Record<string, string> = {};
try {
  if (fs.existsSync(jarPath)) {
    tokenJar = JSON.parse(fs.readFileSync(jarPath, "utf8")) as Record<string, string>;
  }
} catch {
  tokenJar = {};
}

const rawArgs = process.argv.slice(2);
const cmdLine = rawArgs
  .map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
  .join(" ");

const res = executeHiveCli(kernel, { tenantId, actor, tokenJar }, cmdLine || "help");

fs.mkdirSync(path.dirname(jarPath), { recursive: true });
fs.writeFileSync(jarPath, JSON.stringify(res.tokenJar, null, 2));

for (const line of res.lines) {
  console.log(line);
}

store.close();
process.exit(res.ok ? 0 : 1);
