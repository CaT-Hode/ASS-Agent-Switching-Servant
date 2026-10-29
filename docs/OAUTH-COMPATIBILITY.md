# Codex OAuth → OpenCode / pi 兼容性

本文说明 ASS 的 OAuth 格式兼容规则，来源为下文标注版本的官方文档与源码。模型权限和授权有效性以原生客户端登录结果为准。

## 结论

| 来源 / 目标 | 判断 | 条件与证据边界 |
| --- | --- | --- |
| 旧 Codex ChatGPT OAuth → pi `openai-codex` | 保留格式兼容的转移 | 已安装 pi 必须声明支持该 legacy provider；来源须具备 access、refresh、expiry，access JWT 内须有嵌套 chatgpt_account_id，且不能包含相矛盾的 client / issuer / resource / account 元数据；存储账户 ID 不能替代 JWT 字段。 |
| 旧 Codex OAuth → pi 新 `openai` SIWC | 不能通过复制升级 | 新流程使用独立签发的 client 和 plan usage scopes；需由目标客户端原生登录授权。 |
| 旧 Codex OAuth → 所核对的 OpenCode `openai` Codex 路径 | 源码层面格式匹配 | OpenCode 与 legacy pi 使用同一 Codex client，并通过 Codex backend 请求。没有实施 OpenCode 原生转移，也没有证明该用户能完成推理。 |
| 新 SIWC OAuth → 旧 pi `openai-codex` / 所核对的 OpenCode Codex 路径 | 拒绝复制 | 不能丢弃 issued client、scopes 和相关注册元数据，再套用固定 Codex client 刷新。 |
| OAuth 历史 / 已检测到 OAuth provider | 仅是本地记录或能力声明 | 不证明 grant 仍有效，也不授予新 scopes、订阅权益、模型权限或独立额度。 |

复制同一个 refresh token 后，两份文件仍指向同一个可轮换的 grant。一个客户端保存 replacement refresh token 后，另一份副本可能过时；并发刷新或撤销可能使另一端失效。创建新的 ASS profile 只隔离文件，不隔离服务端授权。需要长期独立使用时，应分别在客户端登录。官方要求对同一 session 串行刷新并保存最新 replacement。[Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

## 新旧协议区别

旧 pi 和所核对的 OpenCode 都使用固定 OAuth client `app_EMoamEEZ73f0CkXaXp7hrann`，登录 scopes 为 `openid profile email offline_access`，token endpoint 为 `https://auth.openai.com/oauth/token`。刷新发送固定 client ID 与原 refresh token。pi 的 provider 为 `openai-codex`，OpenCode 的 provider 名称为 `openai`；名称不同不代表 grant 不同。两者分别请求 `https://chatgpt.com/backend-api/codex/responses` 所属的旧路径。下节列出准确源码。

新 SIWC 首次从 `dynamic_agent_client` 注册并取得 issued client ID，使用 `resource=https://api.openai.com/v1`，plan usage scopes 包括 `offline_access resource.invoke chatgpt.tokens.use.direct`。它的 token endpoint 是 `https://auth.openai.com/api/accounts/oauth/token`。刷新必须保留该注册的 issued client ID 与 resource。[Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

同一个人的 ChatGPT 登录身份不等于同一应用注册或同一权限集。新授权的 client 绑定用户与所选 workspace；不能拼接其他注册的 client 与 token。[Overview](https://developers.openai.com/siwc/token-sharing-open-source)、[Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

只有新签发且获相应 plan scopes 的 grant，才适用新文档的 `POST https://api.openai.com/v1/responses`、`store:false`、`stream:true` 合同；不能将它追溯应用到 legacy Codex。新文档也描述了应用读取自己的 token file 再将 access token 交给 app-server 的方式，并没有提供旧 `~/.codex/auth.json` 自动换成新 plan grant 的流程。[Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

`aud=https://api.openai.com/v1` **本身不能区分新旧 grant**：旧 Codex access token 也可能声明这个 audience。核心结合 client、scopes、已知文件格式和账号一致性作本地分类；解码 JWT 不验证签名，也不证明订阅有效。官方把 `response.completed`（或 app-server 成功完成 turn）作为该次推理成功的证据，而不是本地 token 存在或模型目录可见。[Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

## 上游版本、日期与路径

### pi

- `v0.99.0`：commit `4b060d3a98618019adb9985d517516c8e99a2bbe`；发布于 `2026-09-29T17:21Z`，北京时间 09-30 01:21。新增 `/login openai` 的 SIWC；旧 provider 改名为 `OpenAI Codex (legacy)` 并继续保留。[Release v0.99.0](https://github.com/earendil-works/pi/releases/tag/v0.99.0)
- `v0.99.1`：commit `d86654abb8862e201933517d6f1fce9f88dd117f`；commit 日期 `2026-09-29T18:06:55Z`，发布于 `2026-09-29T18:27:00Z`。修复 bundled release 缺少 `openai-chatgpt.js` 的登录错误。[Release v0.99.1](https://github.com/earendil-works/pi/releases/tag/v0.99.1)
- 检查时 HEAD：`3e9451238337071b74ba5cdd53f1ab7cf4100ae8`，`2026-09-30T08:29:06Z`。下列关键 OAuth、provider discovery 文件与 `v0.99.1` 无差异；HEAD 是检出时间快照，不等于新的发布版本。

固定 `v0.99.1` 的源码：

- [packages/ai/src/auth/oauth/openai-chatgpt.ts](https://github.com/earendil-works/pi/blob/d86654abb8862e201933517d6f1fce9f88dd117f/packages/ai/src/auth/oauth/openai-chatgpt.ts)：动态注册、issued client 回调、resource、scopes；存储 `type/access/refresh/expires/clientId/scopes`，按该 client 刷新。
- [packages/ai/src/auth/oauth/openai-codex.ts](https://github.com/earendil-works/pi/blob/d86654abb8862e201933517d6f1fce9f88dd117f/packages/ai/src/auth/oauth/openai-codex.ts)：legacy 固定 client、旧 token endpoint 与刷新逻辑。
- [packages/ai/src/providers/openai.ts](https://github.com/earendil-works/pi/blob/d86654abb8862e201933517d6f1fce9f88dd117f/packages/ai/src/providers/openai.ts) 与 [openai-codex.ts](https://github.com/earendil-works/pi/blob/d86654abb8862e201933517d6f1fce9f88dd117f/packages/ai/src/providers/openai-codex.ts)：新 `openai` 和旧 `openai-codex` 是两个 provider，base URL 与 OAuth loader 各自独立。
- [packages/ai/src/oauth.ts](https://github.com/earendil-works/pi/blob/d86654abb8862e201933517d6f1fce9f88dd117f/packages/ai/src/oauth.ts)、[providers/all.ts](https://github.com/earendil-works/pi/blob/d86654abb8862e201933517d6f1fce9f88dd117f/packages/ai/src/providers/all.ts)、[auth/helpers.ts](https://github.com/earendil-works/pi/blob/d86654abb8862e201933517d6f1fce9f88dd117f/packages/ai/src/auth/helpers.ts) 及 [package.json](https://github.com/earendil-works/pi/blob/d86654abb8862e201933517d6f1fce9f88dd117f/packages/ai/package.json)：`./oauth` 已是 type-only；`./providers/all` 的 `builtinProviders()` 提供 lazy OAuth 定义。检测这些定义不需要调用登录或 refresh。

### OpenCode

- 核对的正式版 `v1.18.33`：commit `51ef4be1d3c122f18fefb510dca8d778571f4f18`，commit 日期 `2026-09-28T04:22:32Z`，发布于 `2026-09-28T04:22:46Z`。[Release v1.18.33](https://github.com/anomalyco/opencode/releases/tag/v1.18.33)、[官方 Changelog](https://opencode.ai/changelog)
- 检查时 HEAD：`2fa3363c924c5c3e367b84a87ae478296a0ed59b`，`2026-09-29T21:43:58Z`。
- [packages/opencode/src/plugin/openai/codex.ts](https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/opencode/src/plugin/openai/codex.ts) 与 [auth/index.ts](https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/opencode/src/auth/index.ts)：`openai` OAuth 仍使用固定 Codex client，存储 `type/access/refresh/expires/accountId`，请求 Codex backend。
- HEAD 的 [packages/core/src/plugin/provider/openai.ts](https://github.com/anomalyco/opencode/blob/2fa3363c924c5c3e367b84a87ae478296a0ed59b/packages/core/src/plugin/provider/openai.ts) 同样使用固定 Codex client。
- 所检查正式版与 HEAD 的 `packages` 源码未出现 `dynamic_agent_client` 或 `chatgpt.tokens.use.direct`。因此不能确认“OpenCode 今日已切换到新的 SIWC plan API”；可以确认的是它现有的 Codex subscription OAuth 路径。将来的版本、未合并分支或插件不在此判断内。

### Codex 与本机版本

- 官方 `rust-v0.159.2`：tag 指向 commit `ff6aec96948b70d94983af2641a6b67c94faeff5`，发布于 `2026-09-29T23:57:16Z`。[Release](https://github.com/openai/codex/releases/tag/rust-v0.159.2)
- [codex-rs/login/src/server.rs](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/login/src/server.rs)：原生 Codex 使用 `/oauth/authorize` 和 `/oauth/token`；较新 Codex 的 scopes 另包含 connector 权限，但它们不会自动形成 SIWC direct-plan scopes。

## ASS 现有接口与此次边界

现有实际转移核心是 `core/oauth-import.cjs`，而非 `oauth-transfer.cjs`。`HarnessManager.oauthSources()` 调用 `enumerateSources()`；`HarnessManager.importOAuth(sourceId, label)` 在导入前重新读取来源并调用 `normalizeOAuth()`，随后创建 **新的 ASS pi profile**，写该 profile 的 `auth.json`。目前没有 Codex → OpenCode 原生导入实现。

既有 IPC 为 `pi-import-oauth(sourceId, label)`，在 `electron/main.cjs` 注册并由 `electron/preload.cjs` 暴露；`src/clients.jsx` 从 `state.harnesses.oauthSources` 展示来源。接口保持不变，UI 补充了不兼容的具体原因与刷新轮换警告。原有导入确认仍是实际执行复制的独立操作，“检查能否”没有执行该操作。

核心保留可辨认的 legacy 文件格式，但拒绝新 SIWC markers、明确不匹配的 client/issuer/resource/account、错误 Codex auth mode、缺失字段和不能判定的 OpenCode grant。OpenCode 的 `openai` 不能仅凭 provider 名称映射为 legacy。允许的旧转移不丢失 account ID，也不覆盖来源和已有 profile。没有新增 SIWC 复制或注册功能。

`piOAuthProviders(executable)` 同时支持旧版 `getOAuthProviders()` 和新版 `builtinProviders()` 的 OAuth 声明。两条路径只返回 `{id,name}`；不调用 `login`、`refresh`、`toAuth`、`getAuth`、catalog refresh 或推理。无法解析安装包、独立二进制没有可发现包导出等情况仍返回空列表，不假定支持。

新增 `oauthTransferCompatibility(kind, data, sourceProvider, {supported, targetProvider})` 是不写文件的核心 helper；`normalizeOAuth` 原三参数调用保持可用，可选第四参数用于约束目标 **pi provider**。来源列表公开字段：

| 字段 | 语义 |
| --- | --- |
| `compatible` | 字段 / grant 格式可复制，且在传入 `supported` 时必须匹配其 provider；并非服务端有效性结论。来源枚举始终传入已检测的 pi providers。 |
| `provider` | 可导入的 pi provider；被拒绝的新 SIWC 标记为 `openai`，以免误称 `openai-codex`。 |
| `grantType` | `codex-legacy`、`chatgpt-plan`、`provider-oauth` 或 `unknown`；描述格式和协议标记，不表示 plan 权限已获批准。 |
| `reasonCode` / `reason` | 稳定代码及固定说明文本，不含 token、client ID、账号标识、加密元数据或任意异常内容。 |
| `requiresLogin` | 来源格式不匹配、未知或不完整时为 true，需用目标客户端的原生授权流程；仅缺少本机 provider 能力声明时为 false，可先重新检测安装能力。 |
| `expired` | 成功解析的访问令牌是否到期；无法解析时不作到期结论。可刷新旧 grant 的过期访问令牌可以保留格式兼容标记，但 ASS 不替它刷新。 |
| `verification` | 固定 `format-only`。 |
| `refreshRotationRisk` / `warning` | 允许复制时提示同一 refresh grant 的轮换竞争；被阻止的复制不发生竞争，不代表该 grant 没有轮换性质。 |

`reasonCode` 目前包括 `compatible_format`、`provider_not_supported`、`chatgpt_plan_login_required`、`oauth_client_mismatch`、`oauth_issuer_mismatch`、`oauth_resource_mismatch`、`oauth_account_mismatch`、`oauth_grant_unknown`、`oauth_auth_mode_mismatch`、`provider_grant_mismatch` 和 `oauth_record_invalid`。
