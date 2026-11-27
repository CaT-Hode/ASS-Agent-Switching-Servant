# Antigravity（agy）接入与能力边界

Google 的 Antigravity App 是独立桌面应用，Antigravity CLI 的命令是 `agy`，另有独立的 Antigravity IDE、编辑器扩展和 Python SDK。ASS 接入范围是 Windows 上的 App、独立 IDE 和 CLI。多种产品共享本机登录，ASS 按同一份原生授权显示账户状态。[产品概览](https://antigravity.google/docs/overview/) · [授权说明](https://antigravity.google/docs/install/)

## ASS 当前支持

- **Windows 安装发现与启动**：从 PATH 及 `%LOCALAPPDATA%/agy/bin/agy.exe` 等路径识别 CLI，通过产品元数据识别 App 和 IDE，支持启动原生 CLI 终端或打开桌面端。
- **订阅额度与点数**。ASS 临时在后台调用 `agy -p /usage` 与 `/credits` 读取当前 Google OAuth 账户的额度分组、重置时间与剩余点数。查询需要 CLI ≥ 1.1.11，执行完立即退出，零模型回合。可以在额度卡手动刷新。ASS 启动发现额度缺失或过期时补查，切换账户后也会刷新。
- **原生 Google 多账户**。在 **客户端与账户 → Antigravity → 添加 Google 账户** 打开原生终端，经 Google 完成新账户登录。ASS 加密保存每个已授权账号。结束原生会话并正常关闭 CLI、App 和 IDE 后，在相应卡片确认切换，下次启动使用选中的账户。切换使用 Windows 共享 OAuth 条目 `gemini:antigravity` 或原生文件回退 `.gemini/jetski-standalone-oauth-token`。余额和额度保留各自账户的缓存，在线查询使用当前启用的账户。[本机账户历史与切换](OAUTH-HISTORY.md)
- **会话级三方模型注入（桌面版 & CLI，动态 Gateway 模式 + 原生多档 Effort）**：在“客户端与账户 → Antigravity → 供应商接入”中纳入任意供应商模型并选择默认模型：
  - **独立模型启动 → 启动桌面版 / 启动终端**：以隔离的 `--user-data-dir=<dataDir>/antigravity-desktop-gateway`（桌面版）或独立进程（`agy` CLI ≥ 1.5.5）配合官方环境变量 `AGY_LLM_GATEWAY_*` 启动，不修改 `~/.gemini/antigravity-cli/settings.json` 与 `admin_settings.json`。
  - **原生多档 Effort 切换**：ASS 通过 `GET /clients/agy/v1beta/models` 为每个支持多档思维强度的模型自动发布 `-(low|medium|high|xhigh|max)` 变体与 `thinking: true`，Antigravity 桌面版下拉框与 CLI `/effort` 会自动将同模型合并为单一条目并提供原生 Effort 档位切换，ASS 路由按所选档位向 Responses / Chat / Messages 上游透传真实 `reasoning.effort` / `output_config.effort` / `reasoning_effort`。
  - **并行共存说明**：Antigravity 官方设计中，Gateway 模式会替换该窗口的 Google 登录后端，因此独立模型桌面窗口内仅显示 ASS 纳入的模型（若需在其中同时使用官方 Gemini，可在 ASS 添加 Google AI Studio / Gemini API 供应商）；原有的个人 Google 账号桌面窗口独立并行、官方模型与订阅额度完全保留。
- **页首一键「ASS 接入」（实时监控 Hook + 同窗口 MCP 桥接）**：与 Codex / Claude Code 一致，在 Antigravity 页首右上角一键开启/关闭：同时管理 `~/.gemini/config/hooks.json`（仅 `ass-monitor`）与 `~/.gemini/config/mcp_config.json`（仅 `ass-router`，完整保留飞书等已有 MCP）。个人 Google 账号窗口内可在保留原官方模型下拉框的同时，通过 `ass_list_models`、`ass_ask_model`、`ass_run_agy_worker` 调用 ASS 三方模型。
- **三端 Token 用量统计（App / CLI / IDE）**：自动扫描 `~/.gemini/{antigravity,antigravity-cli,antigravity-ide}/brain/*/.system_generated/logs/transcript.jsonl` 中的 `PLANNER_RESPONSE` 记录，按 `(conversationId, step_index)` 去重，纳入“路由总览”与 24 小时热力格。实测 Antigravity 的 `input_tokens` 不含 `cache_read_tokens`，ASS 统一按总输入（含缓存读取）归一化。
- **三层实时请求监控**：
  - **A. ASS 路由内（注入终端 / MCP `ass_ask_model` / MCP `ass_run_agy_worker`）**：自动接入“请求监控”与桌面悬浮窗，完整呈现进行中状态、TTFT、可见输出 TPS、缓存命中率、供应商与协议。
  - **B. 只读 Transcript 监听（原生 App / CLI / IDE）**：后台监听新建与追加的 `transcript.jsonl`，每次原生模型调用完成后秒级记录模型与 Token 用量（跳过已由 A 层记录的 `ass-*` 模型以避免重复计数）。原生日志行的 HTTP 状态、耗时、首字延迟和输出速度显示为未知。
  - **C. 可选全局 Hook（默认关闭）**：用户手动开启后，仅在 `~/.gemini/config/hooks.json` 中写入 `ass-monitor` 条目（保留其他已有 hook），捕获 `PreInvocation` / `PostInvocation` / `Stop` 事件以实时显示原生请求的“进行中”状态和已过时间。Hook 的调用序号与 Transcript 的步骤编号分别计数，完成行单独来自 Transcript。Hook 严格过滤掉 `lastUserInput`、工作区路径与 transcript 内容，超时 2 秒且 fail-open 输出 `{}`；关闭开关即完整撤回。[Antigravity Hook 字段](https://antigravity.google/docs/hooks/#preinvocation)
- **原生 CLI 模型目录与只读会话列表**：在 Antigravity 客户端面板按需只读查询 `agy --version`、`agy -p /model`、`/effort` 与 `agy models`（0 次模型回合），并只读列出 App / CLI 的 `conversation_summaries.db`，CLI 会话支持一键 `agy --conversation <id>` 续聊。

## 明确限制与不采用的入口

| 场景 | 说明 |
| --- | --- |
| 修改 Desktop 二进制 / `app.asar` 或绕过企业策略 | ASS 绝不篡改 Antigravity 可执行文件、不拦截 HTTPS 证书、不伪造组织策略；App / IDE 同窗口使用三方模型统一通过官方 MCP 桥接实现。 |
| 持久改写 `settings.json` | 写入全局模型网关或 `modelProvider` 会影响原生 Google 账号体验，因此仅通过进程级环境变量和显式开关管理。 |
| 登录与账号切换 | 新账户通过原生 Google 登录授权。ASS 支持默认共享存储中的 Google OAuth 账户，切换在客户端退出后生效。API Key、Google Cloud ADC 与第三方模型网关各自使用其登录方式。 |
| WSL 中的 `agy` | 留待后续版本单独适配 Linux 凭据库与会话路径。 |

## 本机实测记录

2026 年 11 月 24 日，基于本机 Antigravity App 2.34.0 与 `agy` 1.5.16 验证：
- `AGY_LLM_GATEWAY_URL=http://127.0.0.1:<port>/clients/agy` + `AGY_LLM_GATEWAY_API_KEY=<token>` 支持本机 HTTP 回环连接（非回环才要求 HTTPS）：
  - `AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai` 自动调用 `GET /v1beta/models?pageSize=1000` 发现全部模型并展示 `displayName`，推理发往 `POST /v1beta/models/<id>:streamGenerateContent?alt=sse`（`Authorization: Bearer`），Token 统计精确对齐。
  - `AGY_LLM_GATEWAY_WIRE_PROTOCOL=openai` 自动调用 `GET /v1/models`，推理发往 `POST /v1/chat/completions`，携带全部原生工具并原生解析 `reasoning_content` / `cached_tokens`。
- `transcript.jsonl` 与 `--output-format stream-json` 中的 `input_tokens` 均为未命中缓存的输入数（不含 `cache_read_tokens`）。
