# 更新记录

## v0.6.51

- 悬浮窗额度条使用半透明磨砂背板，保留渐变、粒子和上层文字。
- README 首图与设置预览更新各平台的示例模型。

## v0.6.50

- 请求悬浮窗可选择最多两条订阅额度、显示客户端名称，并以简短名称显示供应商。
- 设置预览在示例背景上显示液态玻璃折射，可调节折射边缘宽度和背景扭曲幅度。
- 修复 Windows 桌面悬浮窗尺寸变化时透出的背景错位。
- 路由总览的账户额度卡显示对应客户端的图标，README 首图展示悬浮窗和八个客户端的示例请求。

## v0.6.49

- 集中管理主题、启动、客户端路径、数据和更新设置。统一应用内的选择器、操作菜单与折叠区样式。
- 请求悬浮窗可预览行数、宽度、圆角和显示字段。尺寸支持液态玻璃滑条与精确输入，今日 Token 汇总可独立于热力图开启。
- 路由总览可从热力格、Token 柱或分类行下钻到项目和原始会话。改善 Codex 与 Antigravity 的用量统计和额度卡，支持额度历史、关注窗口和低额度提醒。
- 注入设置支持逐模型筛选与批量操作，可在应用前预览模型、协议、默认项以及 Windows 和 WSL 生效范围。Antigravity 可以分别管理监控 Hook、同窗口 MCP 与独立模型窗口。
- 请求监控保留筛选偏好，并显示上游请求 ID、失败阶段和原因。

## v0.6.25

# ASS v0.6.25

- 修复用量总览漏读 WSL 项目归档的问题。已知项目内归档的 Claude Code `transcript.jsonl` 现在会参与统计，并按消息 ID 与原位置的记录去重。
- 修复 OpenAI Responses 和 Chat Completions 转成 Claude Messages 时丢失缓存读取字段的问题。新会话可以区分普通输入和缓存读取，输入与输出的总量不变。旧会话中未记录的缓存明细无法通过重扫恢复。
- Codex、Claude Code 和 pi 在检测到对应的 WSL 命令后，供应商名称旁会显示默认开启的 WSL 开关。可以只撤回指定供应商的 WSL 接入，Windows 接入保持原样。

提供 Windows x64 安装包与 SHA256 校验文件。

## v0.6.23

# v0.6.23

- 修复开机自启从旧 `release/current` 启动 v0.6.11 的问题。安装器现在同时更新 `local.ass.desktop` 与旧 `ASS` 两个启动项，并使用具体的当前版本路径。
- 在设置中切换自启动时也会解析出具体版本，避免 junction 保留旧运行版本后再次写入旧启动路径。
- 悬浮窗 TPS 不再显示 `≈`；保留内部估算状态和输出 token 的估算标记。
- 验证：20 项关键测试、生产构建、原生玻璃、包体与隔离安装/卸载 QA。

## v0.6.22

# v0.6.22

- 悬浮窗、请求监控、趋势图、详情和汇总中的 TPS 数值不再显示 `≈` 前缀。
- 估算状态继续在内部保留，用于计算口径、历史兼容和明细提示。

## v0.6.21

# v0.6.21

- 悬浮窗 provider 列增加 4 DIP，耗时列减少 4 DIP，总行宽保持不变。
- TPS 继续以毫秒接收区间计算可见输出，不按整数秒截断。

## v0.6.20

# v0.6.20

- 悬浮窗默认玻璃宽度进一步缩至 288 DIP，5 行高度缩至 210 DIP；热力格边长缩至约 19 DIP。
- 热力格圆角按外框半径派生，默认由 4 DIP 增至 6 DIP，DOM 与原生玻璃遮罩保持一致。
- 请求条目压缩供应商、TPS、缓存和时长列宽，列间距由 4 DIP 降至 2 DIP。

## v0.6.19

# v0.6.19

- 悬浮窗默认玻璃宽度缩至 304 DIP，5 行高度缩至 212 DIP；请求与热力格统一使用 10 DIP 内容内边距，并保持连续外圆角与正方形热力格。
- 未变化的请求行与热力格保留 React 身份；未变化的热力数据不再随每秒刷新重复传给渲染器，减少数据更新时的布局和绘制工作。
- 验证：关键测试、前端生产构建、原生玻璃模块与打包后的真实悬浮窗几何检查。

## v0.6.18

# v0.6.18

- Codex keeps the `openai` provider identity for normal, accountless, and isolated model launches. Inference continues through the local ASS route, so switching login state no longer changes the provider required to resume an existing chat.
- Accountless sync preserves existing ChatGPT or native API credentials. When no native credential exists, ASS adds a local API credential through the encrypted connection transaction and restores the original file on disconnect. A later native login is preserved.
- The old-chat repair action now repairs provider bindings without requiring ChatGPT login. It retains the selected model and conversation history; prediction eligibility remains dependent on native ChatGPT login.
- Local fallback credentials are excluded from native-account discovery. Third-party requests use the supplier credential, and accountless mode continues to reject official-model inference.
- Validation: 23 critical tests and the production client build passed. An isolated installed Codex app-server created a legacy ASS chat, migrated it without login, resumed it, created a new chat, and retained archive visibility. All three inference turns used a synthetic supplier behind the local router.

## v0.6.16

# v0.6.16

- The request widget defaults to a 340 DIP outer width. Its 2×12 heatmap now uses square cells sized from the narrower content width. TPS, cache, and duration columns are tighter while the provider column stays unchanged.
- Native Gaussian material coverage is restricted to completed hour columns. Future heat cells remain visible but sharp, reducing shader samples and making the heatmap's blurred footprint match elapsed time.
- Dragging no longer writes or repairs preferences for every Electron move event. Position is persisted once after the native drag completes, removing a repeated main-process event/timer path while requests are active.
- The glass capacity width is reduced from 640 to 480 DIP, and the request/heatmap material masks are aligned to the compact layout.
- Codex model catalogs keep the full 100% effective context window and trigger auto-compaction separately at the configured 90% token threshold.
- The OpenAI API quota UI links to the official Usage and Billing pages instead of probing unsupported automatic balance endpoints with a normal model key.

## v0.6.15

# v0.6.15

- Model injection triggers native auto-compaction at 90% of the declared context. Codex keeps the full effective context window and uses its separate compact-token metadata; Claude Code receives its per-model `autoCompactWindow` setting, clamped to the CLI's supported 100K–1M range; OpenCode, pi, DSH, Kimi Code, and ZCode receive a 90% context limit for their native compaction logic.
- WSL Codex derives its 90% compact-token limit from the selected model's catalog entry instead of inheriting an unrelated or stale global value.
- OpenAI API keys no longer trigger guessed NewAPI/Sub2API balance requests against `api.openai.com`. The account and supplier views link to OpenAI's API Usage and Billing pages; an explicitly configured custom balance path remains available.
- Icon export decodes the SVG into Canvas instead of capturing a hidden window and checks visible artwork before updating image files.
- Validation: 20 critical tests and the production client build passed.

## v0.6.0

# ASS v0.6.0

本版新增桌面置顶请求悬浮窗、WSL 自动同步，并完善 Claude Code 原生 Messages 与 Auto Mode 审查请求的兼容。

## 请求监控与悬浮窗

- 在“请求监控”或托盘开启悬浮窗，单行显示模型、供应商、可见输出 TPS、缓存命中率和耗时，每秒更新十次。模型继续按末级名称归并，移除 `[1m]` 显示标识。
- 新增条目从左进入，移除条目向右退出；更新数值保留同一个条目节点。完成项原位保留至少 15 秒，新请求可复用完成槽位。窗口尺寸从当前值和速度接续弹性伸缩，期间复用原生纹理与捕获会话。
- 底部 2×12 热力格对应今日 24 小时，先从上到下、再向右排列；格内无文字，悬停查看详细用量。
- 请求框与热力格使用屏幕物理分辨率的局部 5×5 GPU 高斯磨砂，其余背景保持清晰折射。默认圆角 36px、折射边缘 22px，深浅配色平滑过渡。供应商列加宽，移除右上角关闭按钮；右键菜单或 Esc 隐藏。
- 移除拖动的速度形变回弹，前景、采样原点与尺寸使用同一提交帧。GPU 呈现不再为 CPU 完成查询额外等待一轮定时器。
- 明细在内存和磁盘中仅保留最近 200 条，FIFO 删除旧记录；累计用量独立保存，热力格与总览继续累加。

## WSL 与 Claude Code

- Codex、Claude Code、pi 可在客户端设置中开启 WSL 自动同步，Ubuntu 等发行版继承 Windows 已应用的模型和路由，处理路径转换与本机转接。保留两端各自的会话、权限、MCP 和 Hook。
- Claude Code 已确认支持 Messages 的模型使用原生 Messages，不因临时超时或限流降级；Codex、pi 的手动协议选择继续独立生效。
- 修复 Messages 转 Responses 时 Auto Mode 审查的停止序列兼容，覆盖跨数据块匹配、正确停止与上游取消，保留未完成工具调用的安全边界。

## 安装

Windows x64 提供一个完整安装 EXE 与 SHA-256 文件。安装保留正在运行的 ASS、Codex 和用户配置，新版在下次正常启动 ASS 时生效。
