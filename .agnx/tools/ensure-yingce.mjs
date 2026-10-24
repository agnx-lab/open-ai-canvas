#!/usr/bin/env node
/**
 * 场景：影策 ensure — 确保 backend:8080 + web:3000 就绪；一期 SQLite，不启 Docker/yingce-agent。
 * 用法：node .agnx/tools/ensure-yingce.mjs [--work-dir <dataRoot>] [--port 3000] [--backend-port 8080]
 *   [--mode preview|dev] [--supervised] [--force-restart]
 * 默认 --mode=preview（packaged：vite preview + 已 build 的 web/dist + backend/server）；
 * --mode=dev 保留 vite 热更（debug 迭代，不依赖长期 bun run build）。
 * stdout：一行 JSON。--supervised 且需新进程时带 plan（daemon spawn run-yingce-sidecar.mjs）。
 */
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants as fsConstants, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const defaultWebPort = 3000;
const defaultBackendPort = 8080;
const stateFileName = "yingce.json";
const launcherRel = ".agnx/tools/run-yingce-sidecar.mjs";

function parseArgs(argv) {
  let workDir = process.env.AGNX_APP_DATA_ROOT || "";
  let port = defaultWebPort;
  let backendPort = defaultBackendPort;
  let forceRestart = false;
  let supervised = false;
  // 交付默认 preview；热更显式 --mode=dev
  let mode = "preview";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === "--work-dir" || arg === "--workDir") && next) {
      workDir = String(next).trim();
      i += 1;
    } else if (arg === "--port" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) port = n;
      i += 1;
    } else if ((arg === "--backend-port" || arg === "--backendPort") && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) backendPort = n;
      i += 1;
    } else if ((arg === "--mode" || arg === "--runtimeMode") && next) {
      const m = String(next).trim().toLowerCase();
      mode = m === "dev" ? "dev" : "preview";
      i += 1;
    } else if (arg === "--force-restart" || arg === "--forceRestart") {
      forceRestart = true;
    } else if (arg === "--supervised") {
      supervised = true;
    }
  }
  const home = process.env.HOME || "";
  const fallbackData = path.join(home, ".agnx-dev", "apps", "data", "yingce");
  return {
    workDir: workDir || process.env.AGNX_APP_DATA_ROOT || fallbackData,
    port,
    backendPort,
    forceRestart,
    supervised,
    mode,
  };
}

function emit(payload) {
  console.log(JSON.stringify(payload));
}

async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function httpGet(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2500 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).length > 4000) res.destroy();
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function isHealthy(url) {
  const hit = await httpGet(url);
  return Boolean(hit && hit.status >= 200 && hit.status < 500);
}

async function bothHealthy(webPort, backendPort) {
  const webOk = await isHealthy(`http://127.0.0.1:${webPort}/`);
  const backendOk = await isHealthy(`http://127.0.0.1:${backendPort}/api/health`);
  return webOk && backendOk;
}

async function waitBoth(webPort, backendPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await bothHealthy(webPort, backendPort)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function listeningPids(port) {
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { timeout: 4000 },
    );
    return [
      ...new Set(
        stdout
          .split(/\n/)
          .map((line) => Number(line.trim()))
          .filter((pid) => Number.isInteger(pid) && pid > 1),
      ),
    ];
  } catch {
    return [];
  }
}

async function resolveBackendBin() {
  const candidates = [
    path.join(repoRoot, "backend", "server"),
    path.join(repoRoot, "backend", "server.darwin-amd64"),
    path.join(repoRoot, "backend", "bin", "server"),
  ];
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue;
    try {
      await execFileAsync(candidate, [], {
        timeout: 800,
        env: { ...process.env, CANVAS_BACKEND_ADDR: "127.0.0.1:1" },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // 立即因地址占用/缺参退出也说明能 exec；bad CPU type / cannot execute 则跳过
      if (/bad CPU type|Exec format error|cannot execute|No such file/i.test(msg)) {
        continue;
      }
    }
    // 再确认文件可执行：用 `file` + 当前 arch 粗判
    try {
      const { stdout } = await execFileAsync("file", [candidate], { timeout: 3000 });
      const arch = process.arch; // x64 | arm64
      if (arch === "x64" && /arm64/.test(stdout) && !/x86_64|amd64/.test(stdout)) {
        continue;
      }
      if (arch === "arm64" && /x86_64/.test(stdout) && !/arm64/.test(stdout)) {
        // Rosetta 可跑 x86_64；保留
      }
    } catch {
      /* ignore */
    }
    return candidate;
  }
  return null;
}

async function tryBuildBackend() {
  const out = path.join(repoRoot, "backend", "server");
  const goCache = path.join(repoRoot, ".local", "cache", "go-build");
  const goMod = path.join(repoRoot, ".local", "cache", "go-mod");
  await mkdir(goCache, { recursive: true });
  await mkdir(goMod, { recursive: true });
  await execFileAsync("go", ["build", "-trimpath", "-o", out, "./cmd/server"], {
    cwd: path.join(repoRoot, "backend"),
    timeout: 600_000,
    env: {
      ...process.env,
      CGO_ENABLED: "1", // go-sqlite3 需要 cgo；禁用会得到 stub 并秒退
      GOCACHE: goCache,
      GOMODCACHE: goMod,
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  return out;
}

function fingerprintOf(webPort, backendPort, backendBin, mode) {
  return createHash("sha256")
    .update(`${repoRoot}\n${backendBin}\n${webPort}\n${backendPort}\nsqlite\n${mode}\n`)
    .digest("hex")
    .slice(0, 32);
}

function resolveBunBin() {
  const fromEnv = process.env.BUN_BIN || process.env.BUN;
  if (fromEnv) return fromEnv;
  const home = process.env.HOME || "";
  return path.join(home, ".bun", "bin", "bun");
}

function sidecarEnv(cfg, backendBin) {
  return {
    YINGCE_REPO_ROOT: repoRoot,
    YINGCE_BACKEND_BIN: backendBin,
    YINGCE_WEB_MODE: cfg.mode,
    WEB_PORT: String(cfg.port),
    BACKEND_PORT: String(cfg.backendPort),
    CANVAS_BACKEND_DATA_DIR: cfg.workDir,
    CANVAS_DATABASE_DRIVER: "sqlite",
    CANVAS_CORS_ORIGINS: `http://127.0.0.1:${cfg.port},http://localhost:${cfg.port}`,
    CANVAS_AGENT_MAX_PROCESSES: "2",
    ENABLE_PROVIDER_PLUGINS: "false",
    BUN_BIN: resolveBunBin(),
    VITE_API_PROXY_TARGET: `http://127.0.0.1:${cfg.backendPort}`,
    YINGCE_SIDECAR_LOG: path.join(cfg.workDir, "sidecar.log"),
  };
}

function buildPlan(cfg, backendBin, warnings) {
  const launcher = path.join(repoRoot, launcherRel);
  const fp = fingerprintOf(cfg.port, cfg.backendPort, backendBin, cfg.mode);
  return {
    ok: true,
    reused: false,
    warnings,
    mode: cfg.mode,
    fingerprint: fp,
    origin: `http://127.0.0.1:${cfg.port}/`,
    port: cfg.port,
    plan: {
      command: process.execPath,
      args: [launcher],
      cwd: repoRoot,
      env: sidecarEnv(cfg, backendBin),
      fingerprint: fp,
      healthUrl: `http://127.0.0.1:${cfg.port}/`,
      port: cfg.port,
      launchMode: cfg.mode === "dev" ? "debug" : "packaged",
    },
  };
}

async function writeState(statePath, payload) {
  await writeFile(statePath, JSON.stringify(payload, null, 2), "utf8");
}

async function readState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

async function spawnDetachedSidecar(cfg, backendBin) {
  const launcher = path.join(repoRoot, launcherRel);
  const child = spawn(process.execPath, [launcher], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ...sidecarEnv(cfg, backendBin),
    },
  });
  child.unref();
  return child.pid ?? null;
}

async function assertPreviewDist(cfg) {
  if (cfg.mode !== "preview") return null;
  const distIndex = path.join(repoRoot, "web", "dist", "index.html");
  if (await pathExists(distIndex)) return null;
  return {
    ok: false,
    error: `packaged/preview 缺少 web/dist（${distIndex}）。请先：cd ${path.join(repoRoot, "web")} && bun run build`,
    port: cfg.port,
    mode: cfg.mode,
  };
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const warnings = [];
  await mkdir(cfg.workDir, { recursive: true });
  const statePath = path.join(cfg.workDir, stateFileName);
  const origin = `http://127.0.0.1:${cfg.port}/`;

  const distFail = await assertPreviewDist(cfg);
  if (distFail) {
    emit(distFail);
    process.exitCode = 1;
    return;
  }

  let backendBin = await resolveBackendBin();
  if (!backendBin) {
    try {
      warnings.push("预编译 backend/server 当前 arch 不可执行，尝试 go build");
      backendBin = await tryBuildBackend();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      emit({
        ok: false,
        error: `找不到可执行的 backend/server，且 go build 失败：${msg.slice(0, 400)}`,
        port: cfg.port,
        mode: cfg.mode,
      });
      process.exitCode = 1;
      return;
    }
  }

  const webNodeModules = path.join(repoRoot, "web", "node_modules");
  if (!(await pathExists(webNodeModules))) {
    emit({
      ok: false,
      error: `缺少 web/node_modules。请在 ${path.join(repoRoot, "web")} 执行：bun install --frozen-lockfile`,
      port: cfg.port,
      mode: cfg.mode,
    });
    process.exitCode = 1;
    return;
  }

  const fp = fingerprintOf(cfg.port, cfg.backendPort, backendBin, cfg.mode);

  if (!cfg.forceRestart && (await bothHealthy(cfg.port, cfg.backendPort))) {
    const existing = await readState(statePath);
    const sameFp = existing?.fingerprint === fp;
    // 同 fingerprint 才 reuse，避免 debug vite-dev 冒充 packaged preview
    if (sameFp) {
      const pids = await listeningPids(cfg.port);
      const payload = {
        ok: true,
        reused: true,
        port: cfg.port,
        backendPort: cfg.backendPort,
        origin,
        pid: pids[0] ?? null,
        mode: cfg.mode,
        fingerprint: fp,
        warnings,
      };
      await writeState(statePath, { ...payload, updatedAt: new Date().toISOString() });
      emit(payload);
      return;
    }
    warnings.push(
      `端口 ${cfg.port}/${cfg.backendPort} 已监听但 fingerprint 不匹配（旧 mode=${existing?.mode ?? "?"} → ${cfg.mode}）；需 force-restart 或停旧 sidecar`,
    );
    if (!cfg.supervised) {
      emit({
        ok: false,
        error: warnings[warnings.length - 1],
        port: cfg.port,
        mode: cfg.mode,
        fingerprint: fp,
        warnings,
      });
      process.exitCode = 1;
      return;
    }
  }

  if (cfg.supervised) {
    if (cfg.forceRestart) {
      warnings.push("force-restart：由 daemon 按新 plan 拉起；请先 stop 旧 sidecar 若端口被占");
    }
    emit(buildPlan(cfg, backendBin, warnings));
    return;
  }

  // 本机冒烟：自 spawn
  const pid = await spawnDetachedSidecar(cfg, backendBin);
  const ready = await waitBoth(cfg.port, cfg.backendPort, 240_000);
  if (!ready) {
    emit({
      ok: false,
      error: `sidecar 已 spawn(pid=${pid}) 但 240s 内 backend/web 未同时健康`,
      port: cfg.port,
      backendPort: cfg.backendPort,
      pid,
      mode: cfg.mode,
      warnings,
    });
    process.exitCode = 1;
    return;
  }
  const payload = {
    ok: true,
    reused: false,
    port: cfg.port,
    backendPort: cfg.backendPort,
    origin,
    pid,
    mode: cfg.mode,
    fingerprint: fp,
    warnings,
  };
  await writeState(statePath, { ...payload, updatedAt: new Date().toISOString() });
  emit(payload);
}

main().catch((error) => {
  emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
