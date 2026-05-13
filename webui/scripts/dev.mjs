import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webuiDir = path.resolve(__dirname, "..");
const serverDir = path.resolve(webuiDir, "..", "server");

const children = new Set();

function startProcess(label, cwd, args) {
  const child =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], {
          cwd,
          stdio: "inherit",
          shell: false,
        })
      : spawn("npm", args, {
          cwd,
          stdio: "inherit",
          shell: false,
        });

  children.add(child);

  child.on("exit", (code, signal) => {
    children.delete(child);

    if (shuttingDown) {
      return;
    }

    if (code !== 0) {
      console.error(`${label} exited with code ${code ?? "unknown"}.`);
      shutdown(signal ? 0 : code ?? 1);
    }
  });

  child.on("error", (error) => {
    console.error(`Failed to start ${label}: ${error.message}`);
    shutdown(1);
  });

  return child;
}

let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  setTimeout(() => {
    process.exit(exitCode);
  }, 150);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

startProcess("server", serverDir, ["run", "dev"]);
startProcess("webui", webuiDir, ["run", "dev:webui"]);
