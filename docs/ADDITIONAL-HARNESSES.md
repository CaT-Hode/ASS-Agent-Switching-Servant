# 新增客户端适配

本页记录实际实现的能力，不把发现配置文件视为在线授权或模型调用成功。完整接入目标尚未完成。

| 客户端 | 当前能力 | 尚未完成 |
| --- | --- | --- |
| Kimi Code | 新旧版目录与原生账户识别；原生登录发起；文件型 OAuth 自动加密记录与确认切换；官方资料、编程额度、加量包余额查询；按供应商直写 TOML、同步及撤回；本地 Wire Token 记录与首页统计；原生 API / 文件型 OAuth 逐模型直连检测 | 真实账户与完整 Agent 请求尚未验证 |
| ZCode | CLI / Windows 桌面安装识别；原生登录发起；默认、环境变量和桌面自定义数据目录；完整 OAuth 会话自动保存与切换；Start Plan、个人 / Team Coding Plan、MCP 额度；当前账户 Start Plan 运行时模型权益；按供应商直写规则、同步及撤回；本机内置 / 模板 / 个人模型聚合；原生逐请求 SQLite 账本与首页统计；API / Start / 已缓存 Coding Plan Key 的逐模型直连检测 | 真实账户与完整 Agent 请求尚未验证 |

未检测到安装入口或配置来源的客户端不进入首页汇总；仍可在“更多客户端”选择路径。有效配置也是识别证据，但不证明该客户端已安装或在线。

## 读取约束

- 自动目录与账户识别不启动客户端，不执行密钥辅助程序、不刷新授权、不发送模型请求。模型行的闪电按钮才发送小请求（可能计费）。只读识别单文件最多读取 2 MiB，拒绝链接路径；解析失败保留原文件。开启或同步接入时才写模型配置；单独确认 OAuth 账户切换时才写凭据。
- Kimi 新旧数据目录分开识别，不互相借用 token；自定义目录不猜测版本。只读取配置引用的同目录 OAuth 文件；拒绝路径穿越、非文件存储、冲突凭据配置。撤销 tombstone 不产生账户，过期 / 待刷新明确保留状态。
- ZCode 解密遵循原生实现：自定义 `ZCODE_CREDENTIAL_SECRET` 或 OS 平台 / 真实 home / 用户名派生密钥，覆写数据根目录不改变密钥身份。只读取官方 OAuth 命名空间及当前身份 / 项目对应的 Coding Plan Key，忽略第三方 MCP 授权及无关凭据；解密失败不伪造账户。用户资料仅展示同一命名空间缓存中的白名单字段，不推断套餐。
- 只有精确官方 HTTPS 端点的 API 才成为客户端账户。第三方配置模型单独聚合；模型声明不增加账户计数。未声明的上下文、协议、思维能力保持未知，不套用猜测值。
- 前端及后端共同限制尚未实现的账户启动操作。新增客户端默认关闭，不触发自动写入原生模型配置。

## OAuth 账户切换

- Kimi 与 ZCode 接入现有加密历史和账户卡片。原生登录发生变化后自动保存；点击“切换账户”确认后写回当前原生存储，不需要开启模型接入，不自动关闭或重启原生客户端。
- Kimi 只跟踪配置实际引用的文件 OAuth，不扫描无关凭据；中国区、Global 与不同 slot 分开。只替换六个原生 token 字段，保留 TOML 和其他 JSON 字段。无法确定身份的 opaque token 按 refresh grant 区分，不虚构邮箱，也不把轮换令牌当作同一个人。
- ZCode 只记录 `oauth:active_provider` 对应的完整会话（用户资料、access / refresh、共享 `zcodejwttoken` 和登录归因），不把残留的另一供应商 token 配上当前用户 JWT。切换遵循原生互斥身份域规则，清除另一 OAuth 命名空间的旧 token / 用户字段，但保留 API、MCP 等无关凭据。写回使用原生 AES-GCM 格式，并遵循同一文件锁；锁占用时提示重试，不删除别人的锁。
- 完整性、区域、目录、存储来源或环境覆盖有冲突时停止切换。ZCode 会话 JWT 已到期即拒绝切换，不因为 provider 仍有 refresh token 就认为会话有效。只有孤立 token、缺少当前供应商或完整用户资料的旧记录仍可只读显示，但不开放换号。
- 两套 Kimi 配置需先选择版本；CLI / Desktop 同时存在不同有效 ZCode 登录目录时需先指定目录。更多恢复与并发约束见 [OAuth 账户历史](OAUTH-HISTORY.md)。

## 从 ASS 发起登录

- 在 Kimi / ZCode 的“官方账户”标题右侧点击登录图标，选择区域或供应商并确认。先加密保存可识别的旧 OAuth，再打开原生登录终端，由原生客户端处理浏览器授权与令牌写入；ASS 自动记录文件登录变化，不会自动重启客户端。
- 新版 Kimi 使用 `login --region mainland-cn|global`；旧版使用 `login`，仅提供原生默认中国区。能从 npm 包识别新版；程序版本不明确时，先在客户端设置中选择版本，不根据 `kimi.exe` 文件名猜测。两套目录并存或入口与所选版本不一致时要求明确选择。
- ZCode 使用 `login zai|bigmodel`。桌面版必须存在 `resources/glm/zcode.cjs`，通过桌面版自身的 Electron Node 模式运行，不向运行中的桌面窗口传递 CLI 参数。凭据目录须能表示为 `<数据根目录>/.zcode/v2`；自定义配置文件按已选位置保留。
- 登录可能由原生客户端更新默认模型。确认窗提示先结束任务；登录期间不允许 ASS 再次登录、换号或修改同一客户端的接入。终端失败时保留错误等待关闭，避免一闪而过。
- 每次登录使用 ASS 内新的空工作目录，避免加载用户项目 `.env`。子进程清除第三方 API / 授权端点和 Node 启动脚本覆盖项，保留标准代理 / CA 环境变量，Node 启用系统 CA；不关闭 TLS 校验。ZCode 同时保留 `ZCODE_HTTP_PROXY`、`ZCODE_NO_PROXY`、`ZCODE_AGENT_CA_CERT`、超时与原生加密密钥环境，不写入脚本或界面。
- 仅验证了隔离环境中的发起、取消、参数、旧账户保存和并发限制；未替用户进行真实浏览器授权。原生客户端的网络实现与服务端登录结果仍由该客户端负责。

## 账户资料与额度

- Kimi 使用对应中国区 / Global 官方 `/coding/v1/me`、`/coding/v1/usages`。显示返回的用户 ID、邮箱、昵称、会员等级与时间字段，不读取或展示任意资料字段。5h / 7d / 月度总额 / 月度编程额度只显示接口实际返回的窗口；`used_ratio` × 100 为已用百分比，缺失窗口不补零。
- 加量包按原接口固定精度换算，`amountLeft` 不存在时不假定余额为零；保留原币种，不与 Moonshot 通用 API 余额混淆。
- ZCode Start Plan 使用会话 JWT 读取 `/api/v1/zcode-plan/billing/balance`。`app_version` 来自已识别 Desktop 的构建元数据或包信息；没有可信版本则不发这个请求，不借用 ASS 版本或写死一个新版本。Coding Plan / Team / MCP 不依赖此版本，CLI 也可单独查询。
- Start Plan 按可明确归属的有效套餐、额度桶显示剩余 / 总额 / 已用与重置时间，不跨单位求和。剩余使用 `remaining_units`；`available_units` 会扣除进行中请求的预留量，不作为剩余的替代字段。过期与归属不明确的桶不混入当前额度。
- Start Plan 成功查询后读取运行时模型白名单：优先采用额度桶 `capabilities` 中的 `model:` 项，没有时才回退 `show_name`。白名单只约束当前 OAuth 身份、同一数据目录及对应 `account:<family>-start-plan` 供应商；个人 / Team、其他目录和历史账户不受影响。有效套餐未返回白名单时继续使用本机目录，不误判为零模型；查询失败保留同一凭据上次成功白名单与原时间，登录令牌、客户端版本或账户变化后旧结果立即失效。
- 个人 Coding Plan 读取订阅列表、5h / 周 Token 或 Credit 额度及月度工具额度；Team 读取具体组织 / 项目的套餐、有效期、成员分配状态和额度。两者分别展示，不以 `level` 字段猜测套餐有效性。接口 `percentage` 是已用比例，`nextResetTime` 是毫秒；缺少百分比或剩余量时不补零、不反算另一项。
- Coding Plan 用量接口发送原生专用 API Key，不给它额外加 Bearer。Key 优先来自按 OAuth 身份、套餐和项目隔离的原生缓存；缺失时只 GET 当前用户的已有项目 Key 与明文副本，绝不 POST 创建、修改或持久化远端 Key。Team 需核对组织 / 项目成员关系，查询带 `type=2` 和对应 scope 头；Z.ai 与 BigModel 业务令牌分别使用各自原生前缀与官方域名。
- 官方 MCP 单独读取 `/api/v1/mcp/usage` 的 `total_usage`，显示总额、已用、剩余和重置时间，不从旧版 buckets 或模型额度推算。采用 ZCode 会话 JWT + 同一身份的 MaaS 令牌，不混用 API Key 鉴权通道。个人、BigModel Team、Z.ai Team 各遵循原生 scope 头差异；套餐被明确判定失效时移除旧额度，查询失败则保留旧结果与原时间。
- OAuth 历史会加密保存当前身份的 Coding Plan 查询上下文和已有专用 Key；查看历史账户无需切换原生登录。切换账户仍只写 OAuth 字段，不恢复团队选择、不改原生 API Key。自定义业务域名的授权不会被拿去查询生产 Coding Plan 接口。
- 当前和已保存的 OAuth 账户使用自己的令牌查询，包括既有 Codex / Claude / pi 订阅，不用当前原生文件代替历史账户，也不为查看额度切换登录。缓存按授权指纹隔离、加密持久化；资料与额度独立保留上次成功结果，局部失败不清空其他数据，不把旧额度的时间更新成当前时间。
- 查询只读，复用系统 CA / 系统代理、禁止跳转、限制响应大小，不静默刷新令牌。自定义授权端点或无法确认官方作用域的记录不自动向官方服务器发送凭据。实现以官方源码字段为依据；隔离测试不等于真实用户额度已在线核验。

## 本地用量

两者的本地 Token 记录已接入首页，读取格式、去重、缓存与缺失数据边界见[用量总览](USAGE-OVERVIEW.md)。这些记录不代表服务器账单，不反推历史账户归属。

## Kimi 供应商接入

- “客户端与账户 → Kimi Code”可选择供应商，然后开启接入；更改范围后点击同步。直接使用供应商地址与 API Key，不依赖 ASS 路由服务。退出 ASS 不撤回直连配置。
- 新版默认 `.kimi-code`，旧版 `.kimi`；遵循各自环境变量。只存在一套配置时自动识别，同时存在两套或使用未知自定义目录时，在客户端设置选择配置版本。接入期间更换版本或目录须先断开。
- 新旧版本分别使用 `openai` / `openai_legacy`；Responses 和 Anthropic 独立分组。新版写入模型上下文、输出长度、思维范围与默认档位；输出长度是否使用仍由原生协议实现决定。旧版未提供模型级思维范围字段，因此只写其支持的模型字段，思维控制保留在原生客户端。
- 不改 `default_model`、现有供应商和 OAuth 文件。新增 `ass-…` 表由加密日志记录；同步/撤回只处理这些表。未被客户端重排时保留原文件字节；原生客户端去除注释并重排 TOML 后仍按日志确认所有权，不重写其他表。外部修改了 ASS 字段值时停止覆盖。
- 如果用户已把默认模型切到即将撤回的 ASS 模型，先在 Kimi 中切换模型后再关闭，避免留下无效默认模型。

## ZCode 供应商接入

- 在客户端页按供应商纳入模型，开启 / 同步后直写个人 `provider_config.json`。Chat Completions、Responses、Anthropic 分组为独立的 `ass-…` Provider，不开启 ASS 路由，不修改 `credentials.json` 或官方 Account Provider。
- 遵循 `ZCODE_DATA_BASE_DIR`、`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 及手动指定目录。桌面版还读取默认 `~/.zcode/v2/setting.json` 的 `dataBaseDir`，自动发现迁移后的账户和配置。CLI 与桌面出现不同的有效位置时要求指定目录，不猜测写入目标；接入后目标固定，切换须先断开。
- 写入模型上下文、输出上限及可选思维档位，保留 ZCode 原生模型 / 协议的请求参数映射；不伪造工具、视觉等能力。ZCode 没有模型级显示名称和默认思维档位的对应字段，因此模型选择与默认档位留在原生客户端。
- 按 `providerId` 和 `providerId + modelId` 确认条目所有权，不以列表下标或整张列表作为恢复单位。原生重排列表、添加供应商后可继续同步和撤回；重复 / 冲突条目、未知结构、外部修改 ASS 条目会停止覆盖。原有排序、默认模型及非 ASS 规则保留。
- 初次创建文件时补全 `schemaVersion: 1` 和必要的空规则列表，关闭后留下合法空结构；密钥和模型规则全部撤回。当前默认模型属于待移除供应商时，要求先在 ZCode 中切换模型。
- Windows 自动发现常见安装目录下的 ZCode / ZCode Preview；通过 Electron 资源区分桌面版和 CLI。登录只使用明确存在的内置 CLI，不向桌面 UI 传递登录参数或自动重启进程。

### ZCode 本机模型目录

- “供应商与模型”读取本机内置目录和个人配置，不再只显示 `personalModelIds`。模板只为已创建的供应商提供模型，不把全部模板虚构成已配置账户；固定 OAuth 供应商只显示已识别账户所属区域的目录。
- 合并模型通用规则、协议规则、端点规则、模板精确规则、供应商精确规则与个人覆盖。保留原生模型顺序、去重和停用 / 隐藏过滤；上下文、输出上限、思维档位、视觉 / 工具能力来自目录声明。未声明字段保持未知；不执行参数映射表达式，不把声明当成连接实测或套餐权益。ASS 自己写入的供应商继续按配置所有权过滤，避免重复展示。
- 桌面版读取所选安装中的目录；活动缓存按当前平台、真实应用版本及服务地址隔离，并按原生 revision 选择。相同 revision 冲突优先内置目录，无效活动文件回退内置目录，不跨版本 / 服务地址扫描取最大版本。独立程序读取已落盘 bundled 副本，Node CLI 读取入口旁 `provider/zcode-builtin.json`；显式环境路径也可识别。CLI 无可信应用版本时不猜测活动缓存路径；尚未运行而没有落盘目录的单文件程序不会凭空生成模型。
- 只读，不下载或改写原生缓存，不为读取目录刷新 OAuth。官方 `api.z.ai` / `open.bigmodel.cn` 的 Anthropic API 端点也可识别为原生 API 账户。目录解析失败保留可读取的个人模型；正则匹配有时间预算，损坏目录不阻塞主进程。
- ZCode 当前账户成功读取 Start Plan 权益后，ASS 用运行时白名单过滤同一目录中的 Start Plan 模型，并在卡片与模型列表显示匹配数量。白名单中缺少本机目录元数据的模型会提示更新 / 刷新 ZCode，不伪造上下文、思维档位或可检测配置。个人 / Team 模型仍以原生静态目录和逐模型直连检测为准。

### 原生模型连接检测

- 原生模型行右侧提供闪电按钮，测试成功或失败后填充图标并显示上次测试时间。结果沿用加密历史；同名模型在不同客户端、原生账户 / 目录、供应商之间不混用，改变凭据、端点、协议或请求配置后旧记录失效。请求期间发生这些变化也不会保存旧结果。
- API 覆盖 DSH、OpenCode、pi、Kimi、ZCode 的已识别标准协议模型。读取当前声明的地址、请求头与对应凭据，不使用 ASS 代理、不注入、不重启。沿用系统网络 / CA，禁止重定向与远程明文 HTTP。OpenCode 配置的 baseURL 优先于缓存；pi 的 auth.json 优先于模型配置的 Key 占位项。
- Kimi 文件 OAuth 只向原区域的官方 Coding 接口发送；过期令牌、冲突环境覆盖、共享文件的区域歧义不会尝试刷新或借用其他账户。Kimi 原生 `kimi` 协议识别为 Chat Completions。
- ZCode Start 使用原生会话 JWT；个人 / Team Coding Plan 使用当前用户及选定项目的已缓存专用 Key，不使用业务 OAuth token 代替，不创建 Key。缺少专用 Key 时提示先在 ZCode 使用对应套餐。OAuth 端点和套餐必须匹配。原生 OpenAI / Anthropic 文件型 OAuth 采用各自官方协议；其他专有协议、密钥库或外部命令凭据会明确提示暂不支持。
- 检测是一次小型流式文本请求，不运行 Agent / 工具，不执行原生参数映射脚本，也不验证所有思维档位。Chat Completions、Responses、Messages 都要求可见文本和各自的完整结束事件，HTTP 200、半截流和仅推理片段不能标记成功。除 Codex 订阅自身的协议约束外，输出预算为 512 Token，超时 90 秒；不会记录响应正文或凭据。

## 官方依据

2026-09-23 核对：

- [Kimi Code 数据位置](https://moonshotai.github.io/kimi-code/en/configuration/data-locations.html)、[配置文件](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html)。源码 `MoonshotAI/kimi-code` 提交 `6451f1e056e90037bbf832f3578955cf8e55db64`：`packages/oauth/src/storage.ts`、`toolkit.ts`（逻辑 key 到存储 slot 的映射）、`types.ts`、`token-state.ts`、`packages/agent-core-v2/src/app/kosongConfig/configSection.ts`。生产 `bootstrap.ts` 固定使用文件存储，MiniDB 仅作为会话索引与搜索读模型；会话事件仍落在 `agents/*/wire.jsonl`。旧 CLI 提交 `9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82`，`src/kimi_cli/config.py`、`auth/oauth.py`。
- [ZCode 原生凭据](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts)、同目录 `credential-cipher.ts`；[供应商 / 模型规则](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/provider/src/config/rule-data-schema.ts)。同提交的 `provider-config-file-codec.ts`、`provider-data-schema.ts`、`shared/src/model-config.ts` 定义写入格式；`model-execution.ts` 使用 Vercel AI SDK，Anthropic Base URL 保留 `/v1`。桌面目录与安装身份参照 `desktopDataBaseDirBootstrap.ts` 和 `desktop-product-identity.mjs`。
- 模型目录覆盖顺序依据同提交 [Provider Resolver](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/provider/src/resolver.ts)、`config/model-config.ts`、`owned-order.ts`；缓存选择依据 [Built-in Source](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/provider-node/src/zcode-builtin-provider-config-source.ts)、`zcode-builtin-cache-paths.ts`、`desktopProviderConfig.ts`、`provider-runtime-env.ts`。
- Start Plan 动态模型范围依据同提交的 [Start Plan Billing](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/services/src/model-provider/zaiStartPlanBilling.ts) 与 [Provider Availability](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/services/src/model-provider/codingPlanProviderAvailability.ts)。ASS 只缓存经过清洗的状态、模型 ID 与查询时间，不保存响应体，也不写 ZCode 的账户供应商覆盖层。
- Coding Plan / Team 依据同提交的 [Quota Provider](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts)、`codingPlanEntitlement.ts`、`accountProviderCredentialKey.ts`、`accountProviderApiKeyResolver.ts`、`accountProviderTeamPlanRequestKey.ts`；MCP 依据 [MCP Quota Provider](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/services/src/usage-stats/providers/zcodeMcpQuotaProvider.ts)、`officialMcpCredentials.ts`。ASS 仅复用其中只读流程，不执行原生 Key 自动创建或额度重置动作。
- 登录命令以同一提交的 [Kimi `login.ts`](https://github.com/MoonshotAI/kimi-code/blob/6451f1e056e90037bbf832f3578955cf8e55db64/apps/kimi-code/src/cli/sub/login.ts)、[旧版 Kimi CLI](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/cli/__init__.py)、[ZCode `login-command.ts`](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/apps/zcode-cli/packages/cli/src/login-command.ts) 为依据；ZCode `auth-login.ts` 会保存默认模型，`zcodeAgentProcessManager.ts` 定义桌面内置 CLI 的 Electron Node 启动方式。
