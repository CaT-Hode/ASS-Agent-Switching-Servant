# OAuth 账户历史与切换

适用 Codex、Claude Code、pi、Kimi Code 与 ZCode 文件型 OAuth，以及 Antigravity 在 Windows 上的原生 Google OAuth。

## 记录

- 主进程每 2 秒读取已配置的原生目录和 ASS 独立授权目录。文件内容连续稳定至少 750ms 后记录变化。Antigravity 的固定系统凭据条目每 30 秒读取一次，启动和显式刷新时也会读取。即使页面在后台，ASS 运行时仍会记录。
- 凭据、身份资料、更新时间和恢复事务整体使用 Electron safeStorage（Windows DPAPI）加密到数据目录的 `oauth-history.enc.json`。文件丢失或系统加密不可用不会退回明文。损坏的历史不会自动覆盖。
- Codex 去重键包含 provider、用户和工作区，不把同一工作区的其他人当作同一账户。显式工作区或用户与令牌冲突时不记录。JWT 仅作为本地元数据解析，不宣称已经服务端验证。
- 无稳定身份的授权只能通过同一 refresh grant 关联；opaque 令牌连同 refresh grant 轮换时不能可靠判定是不是换了用户，所以保留新记录。Claude 缓存的邮箱只用于展示，不能单独作为合并凭证。
- 同一身份在不同目录存在旧副本时，不用更旧的文件覆盖较新的历史记录。无法保证人工复制了旧令牌、却同时修改时间后仍能识别其新旧；切换不是令牌刷新服务。

## 切换

卡片上的“当前账户”表示当前目标目录里的 OAuth；“切换账户”是原生凭据替换，不是下次启动偏好。确认框只显示账户、简短警告、取消和确定；目标路径可展开。

1. 主进程生成 120 秒、单次使用的确认票据，绑定目标路径、文件内容、Codex 配置与已保存授权的版本。
2. 确认时重新检查；文件变化、目标目录变化、活跃 ASS 请求、API 模式或环境变量覆盖则拒绝。
3. 加密保留当前登录，然后写入原生 OAuth 字段。Codex 保留其他 auth.json 字段；pi 只改对应 provider；Claude 只改 `claudeAiOauth` 与配套 `oauthAccount`，不覆盖用户设置。
4. 写前事务也加密保存。普通失败恢复已经写入且未被外部改动的字段文件；启动时仅在文件仍等于事务的前/后镜像时恢复。外部发生过新登录则停止自动恢复，保留加密备份。

ASS 不结束客户端进程，不撤销旧授权，也不代替原生客户端刷新。文件写入成功不等于运行中的所有窗口已换号；请在任务结束后切换，必要时重启客户端。独立账户目录仍能从 ASS 启动，模型注入范围不随 OAuth 身份切换改变。

Kimi 写回配置引用的同区域、同 slot 文件，保留配置与未知字段；CN / Global 不互换授权。新旧版本并存时先选择版本。Kimi 的标准 token 文件没有用户身份字段，界面以保存时间区分记录，opaque refresh grant 轮换会保留新条目。

ZCode 保存的是当前完整会话：对应供应商的 access / refresh / user_info、共享会话 JWT 与登录归因。换号同步 `oauth:active_provider`，清除另一互斥 OAuth 身份域的残留字段，保留独立 API / MCP 凭据。使用原生 AES-GCM 格式和 `credentials.json.lock/owner-*.json` 协作锁；锁占用时拒绝切换，不清理别人的锁。事务恢复也须取得同一把锁。过期的会话 JWT 不用 provider 的 refresh token 冒充可恢复。

Antigravity 在 **客户端与账户 → Antigravity → 添加 Google 账户** 中打开原生 `agy` 终端。ASS 先加密保存当前登录。在已登录的终端输入 `/logout`，然后在 Google 授权页选择要添加的账号。新登录写回系统后，ASS 会把它加入账户列表。未取得邮箱或姓名时，卡片显示稳定编号，也可用 **编辑备注** 设置本机显示名称。[Google 原生换号说明](https://antigravity.google/docs/workspace/)

关闭 Antigravity CLI、App 和 IDE 后，在目标账户卡选择 **切换账户** 并确认。ASS 将目标账号的完整授权写回当前原生存储，并保留原账号的加密记录和对话。下次启动的原生客户端读取新的共享账号。默认优先使用 Windows 的 `gemini:antigravity` 凭据条目，原生回退到文件时使用 `.gemini/jetski-standalone-oauth-token`。当前 Google OAuth 账户可从 ASS 手动刷新额度，切换后也会补查。自定义凭据目录、Gateway、Google Cloud ADC 和 API Key 模式不使用这套切换。

## 边界

- Codex 仅文件存储支持此切换。`keyring / auto / ephemeral` 不通过读写 auth.json 冒充支持；不改动其存储设置，不探测系统密钥库。
- pi 服务按本机实际安装版本确认的 OAuth 能力开放。
- Kimi / ZCode 可从账户区发起原生登录，选择区域或供应商后确认。启动前保存旧文件 OAuth，登录可能由原生客户端调整默认模型；不自动重启。真实账户在线有效性与跨客户端移植未验证。只有完整文件会话开放切换，不能从残缺缓存推断登录身份。运行中的客户端仍可能缓存授权，需结束任务后切换。具体入口及目录要求见[新增客户端支持边界](ADDITIONAL-HARNESSES.md)。
- 无法找回监测启动前已被覆盖的令牌；退出原生登录后历史仍在，但服务端撤销或刷新链变化可能使旧授权失效。
- 已保存账户可用自己的授权只读查询已适配的资料 / 额度，查询不切换原生登录。缓存按该授权指纹隔离；令牌变化或被撤销后不会套用其他账户的结果。Kimi 与 ZCode 的具体接口和限制见[新增客户端支持边界](ADDITIONAL-HARNESSES.md)。
- ZCode 同时加密保存该身份已有的 Coding Plan Key 和查询项目上下文；历史账户不会借用当前登录的 Key、组织或项目。查询中缺少 Key 时只读取已有远端 Key，不创建、不落盘。OAuth 切换仍只写认证字段，不恢复查询用的项目设置或 API Key。
- 测试只用隔离的合成凭据，不用用户真实账户换号，不发送计费请求。测试不构成真实授权在线有效性的证明。

依据：[OpenAI 官方认证与凭据存储文档](https://learn.chatgpt.com/docs/auth)、各原生适配器和已安装 pi OAuth provider registry。OpenAI 文档明确区分文件、系统密钥库、自动和内存存储，以及原生令牌刷新。

新增适配依据：Kimi Code `6451f1e` 的 `packages/oauth/src/types.ts`、`storage.ts`、`managed-kimi-code.ts`、`region.ts`；ZCode `872ad960` 的 `oauthCredentialRepo.ts`、`shared-credentials.ts`、`credential-cipher.ts` 与 `atomicFileLock.ts`。链接见[新增客户端支持边界](ADDITIONAL-HARNESSES.md)。
