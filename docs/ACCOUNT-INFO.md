# 账户资料与来源

下方资料来源核对于 2026-09-21，记录后端可读取字段，不代表卡片全部展示。ASS v0.2.9 卡片只保留账户名、套餐、额度 / 余额与必要异常；隐藏账户 / 组织 ID、权限、到期及资料来源说明。卡片按当前客户端及绑定显示，身份资料不作为订阅有效或模型可用的判据。同一 API 的原生 / 已保存来源按完整身份合并，同一 OAuth 的多目录来源按授权身份合并；不删除原文件，不合并不同 Key 或不同用户。

## 已实现的字段

| 账户 / 来源 | 可读取的字段 | 读取方式及边界 |
| --- | --- | --- |
| ChatGPT OAuth：Codex、OpenCode、pi、DSH | 邮箱、套餐、工作区 / 账户 ID、用户 ID、令牌到期 | 只读对应账户的 `id_token`；缺少 ID token 时读取 access token 的 OpenAI 命名空间声明。未验证签名或实时权益，明确标为本地声明。账户 ID 冲突时不继承另一工作区的邮箱 / 套餐。 |
| Claude Code OAuth | 已缓存的邮箱、名称、账户 / 组织 ID、组织名；记录存在时显示 subscriptionType、rateLimitTier、scopes | 读取该凭据目录的 `.credentials.json` 和 `.claude.json`；默认原生目录还对应同一用户的 `~/.claude.json`。独立 / 自定义账户不借用全局身份。身份缓存与凭据文件分别标记更新时间。 |
| OpenCode、pi、DSH 其他 OAuth | 授权供应商、明确保存的 email / name / accountId / projectId / scope、到期时间 | 只取白名单字段；DSH 从 `llm-pi-ai/*` grant payload 读取。扩展或供应商未保存身份时不从不透明 token 猜测邮箱、套餐或配额。 |
| DeepSeek 官方 API，包括 DSH 原生 API 记录 | 可供调用余额状态、可用余额、赠金、充值余额，按 CNY / USD 分开；网络出口、目录 / 配置模型数 | 点击资料刷新后 GET `https://api.deepseek.com/user/balance`。接口不返回用户邮箱 / 姓名，不伪造这些字段。 |
| OpenCode Go API，包括 OpenCode / pi / DSH 原生 API 记录 | 滚动、每周、每月窗口的已用与剩余百分比、限流状态、各自重置时间；查询成功才确认 Go 权益 | GET `https://opencode.ai/zen/go/v1/usage`，只按官方返回的 `usage.*.percent`、`status`、`resetsAt` 解析。`percent` 是已用，剩余为 `max(0,100-percent)`。不把 Go 剩余配额当作充值余额。 |
| OpenCode Zen 原生 API | 服务、认证方式、模型数、控制台；可用同一 Key 查询是否有 Go 用量权限 | Go 接口返回 403 时明确显示无查询权限，不假定 Zen 余额为零、不伪造套餐。Zen 现金余额、邮箱及工作区请在控制台查看。 |
| 已绑定的 OpenRouter API / PKCE 生成的 Key | Key 标签、创建者 ID、组织 / 工作区 ID（返回时）、Key 级别、额度上限 / 剩余、累计 / 今日 / 本月使用、重置周期、Key 到期 | 点击资料刷新后 GET `https://openrouter.ai/api/v1/key`。这不是账户现金余额，Key 标签不是用户名。`limit:null` 显示未设置，缺失数值不当成零。不会显示接口返回的密钥样式标签。 |
| 其他 API / Cursor 原生 Key | 已保存的服务与认证信息；保留原有余额菜单和官方控制台 | 没有假定通用的 `/me` 接口。普通 API Key 不自动拥有供应商的 Admin / Billing 权限。未适配的身份资料查询不发请求。 |

## 官方文档与实现依据

- [Codex App Server](https://learn.chatgpt.com/docs/app-server#auth-endpoints)：`account/read` 的 ChatGPT email / planType；`account/rateLimits/read` 是独立接口。本版离线卡片**未调用**这些 RPC，也未把旧套餐声明当成实时限额。
- [OpenAI Codex token_data.rs](https://github.com/openai/codex/blob/48f897e4ce94152818ce0563b3a8aac3a70ce9b8/codex-rs/login/src/token_data.rs)：ID token 白名单，`https://api.openai.com/profile` 与 `https://api.openai.com/auth` 字段。
- [Claude CLI](https://code.claude.com/docs/en/cli-reference)：官方 `claude auth status` 可返回 JSON；[Claude 设置](https://code.claude.com/docs/en/settings)说明原生登录 session 缓存的位置。缓存内部字段是兼容性读取，不宣称为稳定的远程 Profile API；不调用私有 OAuth profile / usage 端点。
- [OpenCode auth](https://opencode.ai/docs/cli/#auth) 与 [官方 auth 类型](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/auth/index.ts)：每个供应商独立凭据；OAuth 的 accountId 可选。
- [pi OAuth 类型](https://github.com/earendil-works/pi/blob/c7cdb460aa8a0cebef3446c4166729b8a0d97ead/packages/ai/src/auth/types.ts) 与 [OpenAI OAuth 适配](https://github.com/earendil-works/pi/blob/c7cdb460aa8a0cebef3446c4166729b8a0d97ead/packages/ai/src/auth/oauth/openai-codex.ts)：供应商保留其原生 credential 附加字段；ASS 不刷新它们。
- [DSH 官方授权适配](https://github.com/deepseek-ai/deepseek-harness/blob/aa8262ec091698bae9a6b04773a6b5b06ad4aef2/packages/llm/llm-pi-ai/src/auth.ts)：grant payload 按 pi-ai 格式保存。
- [DeepSeek User Balance](https://api-docs.deepseek.com/api/get-user-balance/)：余额可用性与分币种余额明细。
- [OpenCode Go 官方用量接口源码](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts)：三档窗口与权益错误；[Zen 计费文档](https://opencode.ai/docs/zen/)说明充值与消费。
- [OpenRouter Current API Key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)：当前 Key 元数据与 Key 级别用量。

## 安全与刷新

- 切页 / 定时本地状态刷新不产生账户 HTTP 查询、不调用模型、不刷新 OAuth、不启动 auth helper、不退出原生客户端。
- 资料查询限于 DeepSeek、OpenCode、OpenRouter 已适配的精确 HTTPS origin 与预设路径；供应商品牌名不能授权向该官网发送 Key。不接受跨域重定向，不转发额外自定义认证头。使用现有 Electron 系统 CA / 网络选择。原生 API 只读取被选记录中明确保存的 Key，不执行 `$` / `!` 外部密钥引用。
- 渲染进程仅收到白名单资料，收不到 API Key、access / refresh / ID token。界面展示的账户 ID / 邮箱属于用户所请求的身份资料，并非访问凭据。
- 官方 API 资料缓存由 Windows 加密存储到用户数据目录中的 `account-info.enc.json`；不进入配置导出、源码或发布包。缓存与 Key、服务入口及网络配置绑定，配置变化立即失效，返回途中切换 Key 不会把旧资料贴到新账户上。
- 15 分钟以上显示“已过时”；失败保留上次成功资料及其时间。没有成功查询时保持未知，不把失败变成零余额。删除凭据后，本地身份随下一次快照清除。

## 原生模型目录

DSH 的 `DEEPSEEK_API_KEY` 对应 DeepSeek 官方目录；OpenCode 的 `opencode` 与 `opencode-go` 分别对应 Zen / Go。进入模型弹窗时只读查询 `/models`，失败保留本机目录并显示错误。不会把原生 Key 复制为新的 ASS 供应商。模型列表本身不验证推理能力或余额。

OpenCode 本机目录合并模型缓存及 JSON / JSONC 声明，兼容 XDG 路径、`OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR`，只归入已登录供应商；本机配置筛选仅用于本机目录，在线目录展示服务端提供的模型。DSH 无显式 `llm-deepseek.models` 时使用[官方插件内置目录](https://github.com/deepseek-ai/deepseek-harness/blob/aa8262ec091698bae9a6b04773a6b5b06ad4aef2/packages/llm/llm-deepseek/src/index.ts)；在线结果优先，避免把旧缓存当作实时列表。
