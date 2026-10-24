#!/usr/bin/env node
/**
 * 场景：影策双进程 sidecar 入口 — daemon supervised plan 只认单 command，
 * 本脚本拉起 backend:8080 + web:3000，前台保活，收到 SIGTERM/SIGINT 时一并杀掉。
 * 环境变量：YINGCE_REPO_ROOT / YINGCE_BACKEND_BIN / CANVAS_BACKEND_* / WEB_PORT / BACKEND_PORT /
 *   BUN_BIN / YINGCE_WEB_MODE=preview|dev（默认 preview=packaged 静态；dev=vite 热更）
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { appendFileSync } from "node:fs";
import { access, constants as fsConstants, mkdir } from "node:fs/promises";

function env(name, fallback = "") {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}

async function pathExists(p) {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function httpGetOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2500 }, (res) => {
      res.resume();
      resolve(res.statusCode != null && res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitOk(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpGetOk(url)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function spawnLogged(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tag = path.basename(command);
  const logPath = process.env.YINGCE_SIDECAR_LOG || "";
  const write = (stream, buf) => {
    const line = `[yingce:${tag}] ${buf}`;
    stream.write(line);
    if (logPath) {
      try {
        appendFileSync(logPath, line);
      } catch {
        /* ignore */
      }
    }
  };
  child.stdout?.on("data", (buf) => write(process.stdout, buf));
  child.stderr?.on("data", (buf) => write(process.stderr, buf));
  return child;
}

/**
 * packaged 默认：vite preview（需 web/dist）；debug 热更：vite / bun run dev。
 * @returns {{ child: import('node:child_process').ChildProcess, webMode: string }}
 */
async function spawnWeb(repoRoot, webPort, backendPort, bunBin) {
  const webDir = path.join(repoRoot, "web");
  const viteJs = path.join(webDir, "node_modules", "vite", "bin", "vite.js");
  const distIndex = path.join(webDir, "dist", "index.html");
  const rawMode = env("YINGCE_WEB_MODE", "preview").toLowerCase();
  const webMode = rawMode === "dev" ? "dev" : "preview";
  const proxyEnv = {
    ...process.env,
    VITE_API_PROXY_TARGET: `http://127.0.0.1:${backendPort}`,
  };

  if (webMode === "preview") {
    if (!(await pathExists(distIndex))) {
      console.error(
        `packaged/preview 需要已 build 的静态产物：缺少 ${distIndex}。请先：cd web && bun run build`,
      );
      process.exit(1);
    }
    if (!(await pathExists(viteJs))) {
      console.error(`缺少 vite：${viteJs}`);
      process.exit(1);
    }
    const child = spawnLogged(
      process.execPath,
      [
        viteJs,
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        String(webPort),
        "--strictPort",
      ],
      { cwd: webDir, env: proxyEnv, detached: true },
    );
    return { child, webMode: "preview" };
  }

  // debug 热更：长期 vite dev（不依赖 dist）
  let child;
  if (await pathExists(viteJs)) {
    child = spawnLogged(
      process.execPath,
      [viteJs, "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
      { cwd: webDir, env: proxyEnv, detached: true },
    );
  } else {
    child = spawnLogged(
      bunBin,
      ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(webPort)],
      { cwd: webDir, env: proxyEnv, detached: true },
    );
  }
  return { child, webMode: "dev" };
}

async function main() {
  const repoRoot = env("YINGCE_REPO_ROOT");
  const backendBin = env("YINGCE_BACKEND_BIN");
  const webPort = Number(env("WEB_PORT", "3000"));
  const backendPort = Number(env("BACKEND_PORT", "8080"));
  const bunBin = env("BUN_BIN", "bun");
  const dataDir = env("CANVAS_BACKEND_DATA_DIR");

  if (!repoRoot || !(await pathExists(repoRoot))) {
    console.error(`YINGCE_REPO_ROOT 无效: ${repoRoot}`);
    process.exit(1);
  }
  if (!backendBin || !(await pathExists(backendBin))) {
    console.error(`YINGCE_BACKEND_BIN 无效: ${backendBin}`);
    process.exit(1);
  }
  if (!dataDir) {
    console.error("缺少 CANVAS_BACKEND_DATA_DIR");
    process.exit(1);
  }
  await mkdir(dataDir, { recursive: true });
  if (!process.env.YINGCE_SIDECAR_LOG) {
    process.env.YINGCE_SIDECAR_LOG = path.join(dataDir, "sidecar.log");
  }

  const children = [];
  let shuttingDown = false;

  const killAll = (signal = "SIGTERM") => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      try {
        if (child.pid && !child.killed) {
          process.kill(-child.pid, signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* ignore */
        }
      }
    }
  };

  process.on("SIGTERM", () => {
    killAll("SIGTERM");
    setTimeout(() => process.exit(0), 800);
  });
  process.on("SIGINT", () => {
    killAll("SIGINT");
    setTimeout(() => process.exit(0), 800);
  });

  const backendAddr = `127.0.0.1:${backendPort}`;
  const backend = spawnLogged(backendBin, [], {
    cwd: path.join(repoRoot, "backend"),
    env: {
      ...process.env,
      CANVAS_BACKEND_ADDR: backendAddr,
      CANVAS_BACKEND_DATA_DIR: dataDir,
      CANVAS_DATABASE_DRIVER: env("CANVAS_DATABASE_DRIVER", "sqlite"),
      CANVAS_CORS_ORIGINS: env(
        "CANVAS_CORS_ORIGINS",
        `http://127.0.0.1:${webPort},http://localhost:${webPort}`,
      ),
      // 一期不启独立 yingce-agent；内嵌 Agent 按需懒启，限制并发
      CANVAS_AGENT_MAX_PROCESSES: env("CANVAS_AGENT_MAX_PROCESSES", "2"),
      ENABLE_PROVIDER_PLUGINS: env("ENABLE_PROVIDER_PLUGINS", "false"),
    },
    detached: true,
  });
  children.push(backend);

  const backendHealth = `http://127.0.0.1:${backendPort}/api/health`;
  const backendOk = await waitOk(backendHealth, 120_000);
  if (!backendOk) {
    console.error(`backend 未在 120s 内就绪: ${backendHealth}`);
    killAll();
    process.exit(1);
  }

  const { child: web, webMode } = await spawnWeb(repoRoot, webPort, backendPort, bunBin);
  children.push(web);

  const webHealth = `http://127.0.0.1:${webPort}/`;
  const webOk = await waitOk(webHealth, 180_000);
  if (!webOk) {
    console.error(`web(${webMode}) 未在 180s 内就绪: ${webHealth}`);
    killAll();
    process.exit(1);
  }

  console.error(`[yingce-sidecar] ready backend=${backendPort} web=${webPort} mode=${webMode}`);

  const onChildExit = (name, code, signal) => {
    if (shuttingDown) return;
    console.error(`[yingce-sidecar] ${name} exited code=${code} signal=${signal}`);
    killAll();
    process.exit(code && code !== 0 ? code : 1);
  };
  backend.on("exit", (code, signal) => onChildExit("backend", code, signal));
  web.on("exit", (code, signal) => onChildExit("web", code, signal));

  // 保活：挂起直到信号
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
