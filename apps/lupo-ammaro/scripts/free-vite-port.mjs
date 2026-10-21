import { execSync } from "node:child_process";

const port = 1420;

try {
  if (process.platform === "win32") {
    const out = execSync(`netstat -ano | findstr ":${port}"`, { encoding: "utf8" });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      const pid = line.trim().split(/\s+/).pop();
      if (pid && pid !== "0") pids.add(pid);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        console.log(`Fermato processo ${pid} sulla porta ${port}`);
      } catch {
        // ignore
      }
    }
  } else {
    execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: "ignore", shell: true });
  }
} catch {
  // porta già libera
}
