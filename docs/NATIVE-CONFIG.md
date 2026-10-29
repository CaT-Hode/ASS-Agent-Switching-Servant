# 原生 API 接入

DSH、OpenCode、pi 的第三方 API 直接连接供应商。ASS 管理下面的配置字段，不转发它们的模型请求。官方账户卡片与模型接入独立；账户切换不改变默认模型，接入不替换官方登录。

ASS 启动或刷新客户端目录时，只读识别 Codex、Claude Code、OpenCode、pi、DSH、Kimi Code、ZCode 的原生 API，并按规范化接口地址、API Key 和请求头聚合到供应商。同一供应商的不同 Key、不同租户/项目请求头会保留为不同项；DeepSeek 根地址与 `/v1` 视为同一 API，其他网关不会盲目去除路径。

API 发现不依赖模型列表。地址、协议和 Key 可以确认但没有模型目录时，也会出现供应商卡片，模型数为 0；可在供应商弹窗请求模型目录，不伪造可用模型。pi / OpenCode 的常见内置 API 支持已知默认地址，其余自定义 API 必须明确提供地址与协议。OAuth、云 IAM、外部取密钥命令和文件引用不转换为普通 API Key，也不执行脚本或扫描未知私密文件。

配置发现覆盖：DSH 旧 `settings.yaml` 与新版当前 profile 的 `cordis.patch.yml`、pi 的 `auth.json` / `models.json` / 明确引用的环境变量、OpenCode 的认证文件/模型缓存/全局配置/自定义路径/ASS 所选工作目录的项目配置/运行时内联配置/Windows 托管配置，以及 Codex 的 provider 凭据和请求头、Claude Code 的 API 环境设置、Kimi 与 ZCode 的自定义 API。无法确定的来源不回退借用其他供应商的 Key。

| 客户端 | 模型与默认项 | API 凭据 |
| --- | --- | --- |
| OpenCode | 全局 `opencode.jsonc` / `opencode.json` 的 `provider.<ASS ID>` | `XDG_DATA_HOME/opencode/auth.json` 的独立 API 项 |
| pi | `PI_CODING_AGENT_DIR/models.json` 的 `providers.<ASS ID>` | 同目录 `auth.json` 的独立 `api_key` 项 |
| DSH | 当前版本的 `profiles/<profile>/cordis.patch.yml`，兼容旧 `settings.yaml` | `.credentials.yaml` 的 `records.llm-pi-ai/<ASS ID>` |

未设置环境目录时采用客户端默认位置；凭据目录覆盖使用客户端页所选路径。OpenCode 尊重 `OPENCODE_CONFIG` 与 `XDG_CONFIG_HOME`，默认文件优先级为 jsonc、json、旧 config.json。只扫描 ASS 明确选择的工作目录及到 Git 根目录的祖先配置，按原生层级合并嵌套选项；不遍历磁盘猜测其他终端的项目，不修改项目文件。环境变量以 ASS 进程可见值为准，无法读取其他终端临时设置的值。

## 使用与撤回

- 接入开关先预览警告，确认后写入全局已启用、有 Key 且兼容的模型，扣除本客户端排除项；无需绑定 API 账户。每个供应商按协议生成稳定的 `ass-<hash>-<protocol>` 标识，不覆盖 `openai`、`anthropic`、`deepseek` 等内置账户。
- DSH、OpenCode、pi、Kimi 和 ZCode 只跳过**当前写入目标**已经使用的同一 API；发现其他凭据目录不代表该 API 当前生效。不同 Key、不同接口与不同路由请求头继续注入。Codex / Claude Code 的代理模型目录不套用直连排除，以免切到网关后丢失模型。
- 聚合不会把 ASS 自己注入的 API 再次导入。供应商/模型删除后不会在下次扫描自动复活；新发现的模型可以加入，已有模型的用户设置保持不变。所有选中 API 都已原生存在时接入为无操作，不会报“没有可接入模型”。
- 接入范围按供应商整组开关；不再选择或接管默认模型。旧版曾接管的默认项在下一次确认同步时恢复，外部冲突仍拒绝覆盖。选择 / 移除账户卡片不改变接入范围。
- 保存供应商 / 模型 / 接入范围只保存草稿；已有接入显示“待同步”，经同步按钮确认才写入。新开的独立账户目录继承上次已应用的字段，已有目录不改写；不会以启动账户为由应用草稿。首次从旧版代理迁移同样需主动确认。
- 客户端页移除“启动模型”，在原生客户端选择模型；官方账户仍可独立启动。DSH 使用当前源码实际支持的 `web` profile。
- 退出 ASS 保留原生直连配置及窗口。主动关闭对应接入开关、或“停止全部接入”，才撤回字段。旧代理窗口仍按原保护流程退出；未由 ASS 启动的任务无法判断是否空闲，请先结束任务。
- 断开只还原 ASS 字段：原生 OAuth 刷新记录、其他供应商、MCP / 插件等无关数据保留。自己改过 ASS 字段时拒绝覆盖。新增文件可留下空对象，DSH `version: 1` 保留，避免破坏后来加入的原生凭据。

## 安全与限制

- **原生客户端需要真实 Key**：ASS 自身凭据及恢复记录仍由 Windows DPAPI 加密；写入原生 `auth.json` / `.credentials.yaml` 的 Key 则采用客户端原生格式，不是 DPAPI 密文。不要分享这些文件。额外请求头写入原生配置，若包含秘密也须同样保护。
- pi 自定义供应商必须声明 `apiKey` 字段才能通过原生目录校验；ASS 写入未设置的 `$ASS_PI_AUTH_REQUIRED` 引用作为声明，实际请求优先读取 `auth.json` 的 Key。不会复制一份明文 Key 到模型目录；删除原生凭据后不会回退到伪造密钥。
- 配置按字段合并，JSONC / YAML 注释保留。写入前核对文件与管理字段，跨文件失败用加密事务记录恢复；恢复遇到外部改动会停止。不要让两个程序同时改同一受管字段。
- 代理与 TLS 由原生运行时负责。ASS 启动时保留代理及 `NODE_EXTRA_CA_CERTS` 环境，启用 `NODE_USE_SYSTEM_CA=1`，不禁用 TLS 验证。ASS 的“系统 / 直连”选项仍用于自身诊断与查询，不等于原生客户端的逐供应商网络设置；普通启动需自行确保客户端的代理 / CA 环境正确。
- pi / DSH 当前原生思维档位最高为 `max`：模型目录不写 `ultra`，不替客户端设置默认档位。OpenCode 的 Anthropic 思维预算交由原生 SDK 处理，不把 OpenAI 的 `reasoningEffort` 强塞给它。
- DSH 依据本机版本写入当前 profile 补丁或旧设置文件；已经打开的 DSH 页面可能需要刷新或重新连接才能更新目录。ASS 不会自动重启正在工作的客户端。
- 直连请求不出现在 ASS 路由日志 / 活跃计数中；客户端卡片标记“原生直连”。ASS 模型闪电测试验证供应商协议和流，不等于验证每种客户端完整任务。

## 依据与验证边界

配置格式以 [OpenCode Config](https://opencode.ai/docs/config/)、[OpenCode Providers](https://opencode.ai/docs/providers/)、[pi 自定义模型](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)、[pi Settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md)、[DSH llm-pi-ai](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/llm/llm-pi-ai) 和 [DSH credentials-local](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/credentials/credentials-local) 为依据。
