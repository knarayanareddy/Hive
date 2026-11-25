import { spawn } from "node:child_process";

const procs = [];

function start(name, cmd, args) {
  const child = spawn(cmd, args, {
    stdio: "inherit",
    env: { ...process.env },
  });
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
    }
  });
  procs.push(child);
  return child;
}

start("api", process.execPath, ["--no-warnings", "--import", "tsx", "src/server/index.ts"]);
start("web", "npx", ["vite", "--host", "0.0.0.0", "--port", "5173"]);

function shutdown() {
  for (const p of procs) {
    try {
      p.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
