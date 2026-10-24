# 影策（yingce）上游嵌入

- 工作方式：整仓魔改（真树在 `~/.agnx-dev/apps/yingce/`，源自 Downloads/open-ai-canvas 复制，禁软链）
- 推荐模式：Wrap + Sidecar（backend Go + Vite web）；Agent 工具一期不做
- 挂载：`guest.auth=none` / capabilities=`cookies` / 策略=`direct-iframe`（桌面可纠偏）
- 上游：本机复制自 `open-ai-canvas`（无 `.git`）；原仓库 https://github.com/ddcat-ai/open-ai-canvas
- Port 切片：无（一期只胶水）
- 默认值：`sidecar.supervised=true`；backend `8080` + web `3000`；数据目录 `$AGNX_APP_DATA_ROOT` 或 `~/.agnx-dev/apps/data/yingce`；SQLite；`ENABLE_PROVIDER_PLUGINS=false`；不启 Docker / 独立 yingce-agent

## 嵌页宿主能力缺口

| 上游能力 | 信号位置 | 嵌后风险 | 处置 (A–E) | 主路径 | 备注 |
| --- | --- | --- | --- | --- | --- |
| Cookie 登录会话 | `withCredentials` / 注册管理员 | iframe 三方 cookie 限制 | B（capabilities cookies）+ 桌面 guest-webview 纠偏 | 是 | auth=none，仍声明 cookies |
| 选本地文件/素材上传 | 画布导入 / `<input type=file>` | 一般可用 | D 降级观察 | 是 | 一期不接标准桥 |
| Reveal in Finder | 无明确主路径 | 低 | D 不接 | 否 | — |
| 独立 yingce-agent | Compose / YINGCE_AGENT_URL | 一期不启 | D | 否 | 内嵌 Agent 懒启，限并发 2 |
| 全量 provider plugin | ENABLE_PROVIDER_PLUGINS | 一期关闭 | D | 否 | — |

## ensure

默认 **`--mode=preview`（packaged）**：`vite preview` 静态服已 build 的 `web/dist` + `backend/server`。  
debug 热更：`--mode=dev`（长期 `vite` / `bun run dev`，不依赖 dist）。

```bash
# 交付 / packaged（默认 preview；需先 cd web && bun run build）
node ~/.agnx-dev/apps/yingce/.agnx/tools/ensure-yingce.mjs --supervised --port 3000
# 显式 preview：
node ~/.agnx-dev/apps/yingce/.agnx/tools/ensure-yingce.mjs --supervised --port 3000 --mode preview
# debug 热更：
node ~/.agnx-dev/apps/yingce/.agnx/tools/ensure-yingce.mjs --supervised --port 3000 --mode dev
# 本机冒烟（会自 spawn）：
node ~/.agnx-dev/apps/yingce/.agnx/tools/ensure-yingce.mjs --port 3000
```

预编译 `backend/server` 若为 arm64 而 shell 为 amd64，ensure 会尝试 `go build` 覆盖/产出可执行文件。  
`vite.config.ts` 的 `preview.proxy` 与 `server.proxy` 同把 `/api` 转到 backend，避免静态 preview 丢代理。

## 一期踩坑（本机）

1. Downloads 预编译 `backend/server` 为 **arm64**；若终端为 **x86_64/Rosetta**，需 `CGO_ENABLED=1 go build -o backend/server ./cmd/server`（go-sqlite3 必须 cgo）。
2. 内置技能 `豆包音频提示词` 原 `tag: audio` 不在允许分类中，会导致 EnsureBuiltinSkills 失败秒退；已改为 `tag: others`。
3. supervised plan 单命令：`.agnx/tools/run-yingce-sidecar.mjs` 同时拉起 backend+web；healthUrl=`http://127.0.0.1:3000/`。

## 一期踩坑补记（2026-10-15 桌面 Tab 验收）

4. Vite 8 + antd 6：`web` 里 `@rc-component/util@1.11.0` 缺 `render`/`unmount`/`isStyleSupport` 主入口导出，dependency optimize 崩溃 → Guest 卡「正在加载」且 3000 进程退出。已升到 **1.14.0**（antd peer `^1.11.1`）。验收：桌面 Tab 内 Guest `title=影策`，可点「开始创作」。

## packaged 翻态（交付）

1. `cd web && bun run build`（冷启动复用 `web/dist`）
2. `npm run sub-apps:register -- --app-id=yingce --launch-mode=packaged --install-state=installed`（在 agnx 仓根）
3. 停掉旧 vite-dev sidecar（fingerprint 变了不能 reuse）→ 重新扫描 → 开影策 Tab
4. 桌面 Tab：`gate error` 空 + Guest 实质 UI + screenshot
