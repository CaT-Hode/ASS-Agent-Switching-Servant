# 来源与实现边界

ASS 是独立实现，不是原产品的官方版本。界面不沿用旧产品品牌；供应商用户名称、导入 ID 和兼容字段保留以避免破坏既有模型引用。

## 兼容性参考

- [AiMaMi 公开仓库](https://github.com/borawong/AiMaMi)：公开树与 Apache-2.0 声明。所检查的公开树并不包含完整路由实现，因此不能声称从此仓库复制了完整代理内核。
- [OpenAiMaMi 证据仓库](https://github.com/MapleEve/OpenAiMaMi)：观察 1.2.6 Windows 前端供应商、协议和上下文默认值，以及已有余额端点行为。ASS 独立编写规范化、余额解析与路由实现；没有将反编译代码或安装版二进制打包发布。
- 用户导出格式中的 `providers / models / wireApi / baseUrl` 等兼容字段。真实导出不在此仓库内。

## 官方文档和原生实现

- [DeepSeek 与 Claude Code 集成](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code/)：DeepSeek 的原生 Anthropic 兼容入口。ASS 在 Claude 请求中使用该入口，不用修改官方账户归属。
- [OpenCode Go](https://opencode.ai/docs/go/)、[Zen](https://opencode.ai/docs/zen/)：编码客户端接入范围、逐模型协议与原生会话标识。ASS 保留原客户端已有的会话头与 User-Agent，诊断使用自己的会话标识；不伪装原生客户端身份来绕过权限。不同模型按其协议接入，不将整个供应商强制标为同一个协议。

- [Electron net](https://www.electronjs.org/docs/latest/api/net)、[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)：网络与本地 Key 保护。
- [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference)、[authentication](https://learn.chatgpt.com/docs/auth)：provider 及账户目录。
- [Codex model protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs)：catalog enum，含 `tool_mode=direct`、保留 provider 与工具能力声明。
- [Claude Code authentication](https://code.claude.com/docs/en/authentication)、[settings](https://code.claude.com/docs/en/settings)：原生登录、`CLAUDE_CONFIG_DIR`、API 环境变量。
- [OpenCode providers](https://opencode.ai/docs/providers/)、[config](https://opencode.ai/docs/config/)、[CLI](https://opencode.ai/docs/cli/)：Go / 通用 API、inline config、原生账户命令。
- [pi provider docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md)、[model docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)：API 与 OAuth。
- 本机测试用 pi 0.73.1 的 OAuth 注册表与凭据字段：`@mariozechner/pi-ai` 的 `dist/oauth.js`、`dist/utils/oauth/openai-codex.js`、`anthropic.js`。新 namespace `@earendil-works/pi-ai` 也可探测。运行时优先实际安装版本，不把旧网页名单写成能力承诺。
- [DeepSeek Harness llm-pi-ai](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-pi-ai)、[default model](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/agent-default-model)：隔离配置与模型接入。测试用 0.1.5-rc.2 实际 schema。

这些链接用于说明兼容性依据，不代表原作者对 ASS 的认可。第三方订阅使用范围和计费遵循相应供应商条款。

## Codex 历史入口与重启兼容（2026-09-29）

- 用户指定的 AiMaMi 公开树 `add37271e29ba81ee17f15f444a24925af50bb87`，`src-tauri/src/platform/process.rs`：参考停止客户端、等待退出、应用配置、恢复安装入口的顺序。没有照搬按进程名结束所有实例的做法；当前本机 Codex 的 AppX 清单入口为 `app/ChatGPT.exe`，ASS 动态读取清单并验证进程身份。
- OpenAI Codex `rust-v0.158.0-alpha.2` 的 `codex-rs/model-provider-info/src/lib.rs`、`core/src/config/mod.rs`：`openai_base_url` 参与构建内置 OpenAI provider；普通内置 provider 不能通过同名配置覆盖。ASS 使用该配置管理官方入口，不重写聊天记录。按用户要求，当前只保留 `ASS` provider 与当前路由入口；旧别名、旧接入记录的自动迁移代码已移除。
- 同版本 `codex-rs/core/src/client.rs`：WebSocket 握手返回 HTTP 426 会进入 HTTP 回退。ASS 没有实现 WebSocket 代理，不用 405 冒充回退成功。
- 官方配置文档本轮获取返回 403；以上行为依据公开源码与隔离测试，不把无法打开的文档当成已验证证据。运行时验收范围由实际测试结果单独说明。
- 0.2.5 的本机 `codex-cli 0.158.0-alpha.2.1` 隔离运行完成四条调用（含当时存在的旧别名）。0.2.6 的测试脚本仅保留内置 `openai` → 第三方 / 官方模型、`ASS` → 第三方三条当前入口；旧别名和旧地址改为拒绝断言。测试使用虚构凭据、本地 ASS 与内存上游，不验证真实上游服务，也不关闭运行中的桌面实例。

## Codex 无账号模式与保留 provider 的对话（2026-10-20）

- 本机 `codex-cli 0.163.0-alpha.10.2` 的隔离 `app-server`：对话在全局 provider 为内置 `openai` 时创建后，会保存该 provider；切换 ASS 配置并 `thread/resume` 后仍按保存的 provider 使用本机 ChatGPT 登录凭据。`codex exec resume` 会按当前配置重算 provider，两者行为不同，ASS 以桌面端 `app-server` 的行为为准。证据脚本 `scripts/codex-accountless-retained-qa.cjs` 使用虚构 OAuth、本地刷新模拟和内存上游，不发起云调用。
- 该版本拒绝同名覆盖内置 provider（`model_providers contains reserved built-in provider IDs: 'openai'. Built-in providers cannot be overridden.`），因此旧对话不能靠 `[model_providers.openai]` 改成静态本机令牌。ASS 只在请求侧接受本机可读的当前官方凭据用于本机认证：凭据不转发上游、不读取官方额度，官方模型和无账号模式下的官方账户请求仍被拒绝。没有可读凭据时，旧对话需在 Codex 中新建。

## Codex 旧对话预测兼容（2026-10-20）

- 本机 Codex 桌面版 26.1013.4894.0 的预测实现只接受 `modelProvider === 'openai'`；已保存为 `ASS` 的对话直接返回 `unsupported_provider`。全局设置不能替代旧对话的供应商绑定；官方预测配置、模型限制和内容检查仍独立生效。
- `ASS_QA_PREDICTION=1 node scripts/codex-session-handoff-qa.cjs` 使用当前安装的后端、临时客户端目录、虚拟 OAuth 和本地模拟服务，验证 provider-only 修复后的重载、第三方模型/上下文保留、`experimentalPredictionMode` 临时分支与 JSON schema 输出。当前分页历史的预测分支要求 `ephemeral: true` 和 `excludeTurns: true`。没有真实云调用，也没有改动本机用户对话。

## v0.1.1 官方账户与 API 入口

- [OpenRouter PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth)：S256、localhost 回调、`/api/v1/auth/keys` 换取 API Key。实现不是订阅 OAuth 通用移植器。
- [Cursor CLI authentication](https://cursor.com/docs/cli/reference/authentication)：原生浏览器登录与 API Key；本版只做原生 Key 保管，不推断 OAuth 文件格式或多账户隔离。
- [Kimi Code](https://www.kimi.com/code/docs/en/)：Kimi 原生登录、Code API / Moonshot 区域入口；ASS 只跟踪原生文件 OAuth 的变化并加密保存可切换历史，不自行刷新或撤销授权。
- [Z.ai API](https://docs.z.ai/api-reference/introduction)、[OpenCode Go](https://opencode.ai/docs/go/)：套餐与一般 API 入口区分。
- [Anthropic API](https://platform.claude.com/docs/en/api/overview)：API Key 与原生订阅授权分开。
- [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)、[Groq](https://console.groq.com/docs/openai)、[Mistral](https://docs.mistral.ai/api)、[xAI](https://docs.x.ai/developers/rest-api-reference/inference/chat)、[SiliconFlow](https://docs.siliconflow.cn/docs/api/chat-completions-post)、[Qwen / DashScope](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)：兼容 API 基址与协议。

模型目录字段与小请求结果分别展示为“声明”和“实测”；上游参数接受不等于不同档位的推理质量验证。未公开能力保持未知，不根据模型名称冒充实测结果。

## v0.1.2 更新检查

- [GitHub Releases API](https://docs.github.com/en/rest/releases/releases#list-releases)：公开版本、预览标记、发布资源名称与上传状态。
- [GitHub REST 最佳实践](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)：ETag 条件请求、串行合并及限流退避。
- [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)：Windows 原生自动安装方案涉及对应打包机制；当前 ASS 是便携 ZIP，只实现自动检查和浏览器下载，不声称已经支持后台自动安装。

## v0.1.5 本机授权检测

- [Codex authentication](https://learn.chatgpt.com/docs/auth)：`CODEX_HOME/auth.json` 与 file / keyring / ephemeral 存储边界。
- [Claude Code authentication](https://code.claude.com/docs/en/authentication)：Windows `.claude/.credentials.json` 与 `CLAUDE_CONFIG_DIR`。
- [OpenCode providers](https://opencode.ai/docs/providers/)：原生 `auth.json`，供应商分别保存凭据。
- [Pi AuthStorage 源码](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/auth-storage.ts)：`oauth` 与 `api_key` 记录，读取时不执行动态密钥命令。
- 本机 `D:\deepseek-harness\packages\credentials\credentials-local\README.md` 与 `packages\llm\llm-pi-ai\src\auth.ts`：版本化 `.credentials.yaml`、`refs`、`records` 和 `llm-pi-ai/<provider>` grant 结构。只实现已确认格式，不把任意插件 grant 误判为 OAuth。

## Codex 图片工具接入

- 本机 Codex Desktop `26.1013.4894.0` 附带后端 `0.163.0-alpha.10.2`：隔离 OAuth 和本地模拟服务实际捕获 `image_gen.imagegen` 请求模型接入地址的 `/v1/images/generations`，编辑时请求 `/v1/images/edits`，附带账户与 `x-codex-image-turn-id`。
- `scripts/codex-images-qa.cjs` 使用实际后端经 ASS 路由完成生成、带本地图编辑及保存，分别验证内置 `openai` 与自定义 `ASS` 供应商。官方 Codex 后端的图片接口为 Responses 同级的 `images/generations` / `images/edits`；原始请求字节与图片结果保留。测试上游为本地模拟，无真实云端请求。
- 本轮 OpenAI Docs 搜索工具不可用，官方图片生成文档页面返回 403；以上结论来自本机请求与原生工具回归，不将网页摘要作为依据。

## 本地对话与 OAuth 保留

- [Claude Code Manage sessions](https://code.claude.com/docs/en/sessions)：CLI JSONL 目录、`CLAUDE_CONFIG_DIR`、绝对 transcript 路径续聊，以及 CLI / Desktop / Web 历史分离的边界。按本机 2.1.283 可用行为适配。
- [OpenAI Codex TUI / resume 实现](https://github.com/openai/codex/blob/rust-v0.158.0-alpha.2/codex-rs/tui/src/lib.rs) 与本机 CLI 帮助：UUID 续聊与本地会话选择。官方 Codex 文档本次仍无法打开，未把搜索摘要当作实现依据。
- [AiMaMi 中文 README](https://github.com/borawong/AiMaMi/blob/main/README-cn.md) 的本地会话管理与历史续聊定位用于需求对照；其公开源码不含完整会话管理，未宣称照搬缺失的实现。保留、加密、恢复与 CC 支持由 ASS 自行实现。

## 项目级跨客户端对话同步

- [pi 会话格式与 SessionManager](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sessions.md)：v3 JSONL 父链、活动分支、压缩摘要和原生会话写回。本轮以安装的 pi SessionManager 验证可读上下文及写回收集，不把树的其他分支拼进活动上下文。
- [OpenCode CLI](https://opencode.ai/docs/cli/)：官方 `import` / `export` 与 `--session`。本轮用隔离原生 CLI 完成导入 / 导出，并只读其 SQLite 消息；生成 ID 按原生字典顺序有序，不绕过原生导入写数据库。
- [DeepSeek Harness 持久化](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md) 与本机 `D:\deepseek-harness\packages\session\session-format-catalog`：日志世代、Zstandard、目录编码、turn / step / message 结构。生成 v3 经本机严格校验器接受；未知版本拒绝强制转换。
- Codex 与 CC 的续聊依据上节；本轮另做 Codex → CC → Codex 的真实 CLI 回环，以合成 OAuth 与本地模拟上游确认共享历史和当前账户使用。跨格式映射、共同前缀去重和分支保留为 ASS 独立实现，不声称是厂商支持的跨客户端协议。

## 视觉

ASS logo 为本项目原创设计。基线 `public/ass-logo-reference.svg` 依据用户指定的 `docs/assets/ass-reference-flat.png` 逐瓣描摹。0.2.17 的最终 `public/ass-logo.svg` 逐字保留八片实际花瓣路径，仅修改中心：从真实根部及八条空隙宽度导向边构造法向偏移外沿，内孔为正圆，不用旋转复制或重新绘制花瓣。参考图来源、轮廓覆盖指标、导出清单与仅开发期使用的描摹工具边界见 [Logo 记录](docs/LOGO.md)。PNG、程序和 Windows ICO 均由最终 SVG 统一导出。其他图标使用 Lucide。系统字体与交互针对横向桌面窗口设计。

图像编辑提示词保留于 [logo 编辑记录](docs/LOGO.md)。
