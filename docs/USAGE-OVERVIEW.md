# 用量总览

首页不再展示模型来源、安全说明和请求列表，改为已有账户与用量；模型管理仍在供应商页，请求列表仍在连接诊断。开机启动选项移到关于 ASS。

## 视图

- 客户端筛选仅显示已识别的客户端，包含 Codex、Claude Code、OpenCode、pi、DSH、Kimi Code、ZCode；只筛选展示，不切换登录或路由。尚未适配用量的客户端不补造 Token。
- 活跃趋势：本周每格 1 小时，本月每格 4 小时，小方格均先从上到下、再从左到右排列。每列 6 格，本周每天 4 列，本月每天 1 列；近一年保持原来的 365 日热力图。悬停 / 键盘聚焦显示对应日期或小时区间、次数、Token；未来日期 / 小时留空，不显示为零。
- Token：非缓存输入、缓存输入、输出堆叠；同一范围内可按客户端或模型分类。
- 模型分类统一按 `::` 或 `/` 分隔后的最后一级模型名合并，适用于所有客户端和历史缓存。例如 `ASS_xxx::openrouter/vendor/model` 与 `vendor/model` 合并为 `model`；原始记录及各项计数保留，仅改变展示与汇总分组。
- 账户与额度：展示已有账户和其上次查询结果，支持单账户刷新。多个客户端绑定同一 ASS API 账户时合并显示一次，不相加余额。订阅窗口按账户分别展示，不相加百分比、不折算 Token。
- 本周从本机时区的星期一开始，本月从 1 日开始，近一年为含今天的 365 天。额度不受历史日期切换影响，它表示当前保存的额度快照。
- Token 趋势同样使用本周 1 小时、本月 4 小时的粒度；年视图仍按天。本月区间为 00–04、04–08、08–12、12–16、16–20、20–24 时。当前区间尚未结束，只包含已经读到的记录；小时按本地钟点聚合，夏令时回拨时同名小时合并。
- DSH 日账本以及缺少小时信息的记录不拆到小时：周 / 月视图在图下单独展示“仅按日记录”及可展开的每日明细，仍计入顶部总量与用量分类。分时图总量 + 仅按日记录 = 总量。全部来源都只有日账本时，不绘制虚假的分时图。

## 本地数据来源

| 客户端 | 只读来源 | 计数处理 |
| --- | --- | --- |
| Codex | sessions / archived_sessions 下的 JSONL | 按累计差值计量；同一累计值不重复入账；第一条以 last_token_usage 避免把继承的累计量再次计入；时间早于会话创建的分叉种子不计 |
| Claude Code | projects 下的 JSONL | assistant message ID 去重，流式修订替换同一条记录；输入包含缓存读取与创建 |
| OpenCode | opencode.db 的 message / session 表 | SQLite readOnly，仅读 assistant 用量元数据；过滤早于会话创建的分叉复制消息；输出补回独立 reasoning 字段 |
| pi | agent/sessions 下的 JSONL | assistant message 按 ID 去重，输入加缓存读取 / 写入，跳过分叉种子 |
| DSH | storages/cost-meter/ledger.json | 使用已有插件日账本的模型分组；不叠加日合计 / 会话合计；没有此账本时不伪造历史数据 |
| Kimi Code | 新版 `.kimi-code/sessions` 与旧版 `.kimi/sessions` 内的 `wire.jsonl` | 新版只计 `usage.record`，不叠加状态累计或消息副本；`forked` 标记前的继承历史不计。旧版只计 `StatusUpdate.token_usage`，按 message_id 替换修订 / 去重复制；输入加缓存读取和创建 |
| ZCode | 默认 `.zcode/cli/db/db.sqlite` 的 `model_usage` 表 | SQLite readOnly，只取已结束请求的用量字段，不读提示词 / 原始响应；当前 input 已包含缓存，旧记录按原生总量判定口径；reasoning 不再叠加到 output |

读取客户端已知目录、配置目录覆盖和 ASS 独立账户目录，包括已移除账户卡片留下的会话目录；不需要让请求经过 ASS 代理。**不采集会话内容，不发送模型请求，不刷新 OAuth，不改写客户端文件。** 不把 ASS 路由日志再相加，避免一个请求被统计两次。历史记录通常没有可靠的登录账户归属，因此只支持客户端 / 模型分类，不猜测每条请求属于哪一个当前账户。

Windows 上会检测所有正在运行的 WSL 发行版，以各发行版自己的用户目录以及运行中 Codex、Claude Code、pi 的 `HOME`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR` 定位记录。Linux 路径通过 `wslpath` 转成可读的 Windows / WSL 路径，不固定发行版名、用户名或盘符。刷新不会启动已停止的发行版；已观察到的 WSL 用量在不可访问时保留并标为部分记录，恢复运行后继续读取。

项目发现范围来自 Codex 保存的本地项目、ASS 当前工作区及 WSL 中运行的 CLI 所在项目（优先 Git 根目录）。在这些范围内按原生 `projects` / `sessions` / `archived_sessions` 结构和 JSONL 元数据识别隔离目录，不要求配置目录叫 `.claude`、`.codex` 或其他固定名称。依赖、构建产物和测试夹具目录跳过；不将用户 home 或整个盘符当作项目递归扫描。新发现的目录加密保存，CLI 退出后仍继续采集。手动刷新立即发现或续扫项目；自动刷新每十分钟启动一轮项目发现，未完成的批次每分钟续扫，期间照常更新运行环境和已知用量文件。待扫描目录和已遍历目录的摘要随加密缓存保存，重启后从断点继续，不反复只扫描大型项目的前半段。

Windows 原目录、WSL 路径、项目目录及 ASS 独立目录共用一套记录去重：Claude 按 message ID，Codex 按会话 ID、累计用量事件标识，pi 按原生消息 ID；流式修订按原有时间 / 文件版本优先级替换，不把不同路径读到的副本再次相加。模型仍按最后一级名称汇总。只有 WSL 安装的客户端也会按实际读到的用量进入筛选。

输入统一包含缓存读取与写入，总 Token = 输入 + 输出；推理包含在输出内。缓存读取为输入的子集，不额外加到总量。调用数为读到的用量记录数，不等于付费账单请求数。会话按匿名摘要去重，模型切换不增加会话数。没有输入 / 输出计数的记录不作为零 Token 记录。

OpenCode 独立输出 / 推理口径依据[官方 getUsage 实现](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts)；DSH 本机 llm-deepseek / llm-pi-ai 适配器将 inputTokens 与 cacheReadTokens 分开上报。

Kimi 新版模型 / 供应商仅使用日志中可匹配的 `llm.request` 和 `usage.record`；旧版没有此信息的记录显示“未标注”，不使用当前配置反推历史。主代理与子代理归入同一会话；新版中标记为旧版迁移副本的会话不重复导入。旧版缺少 message_id 时只能按文件内记录计数，无法可靠识别跨文件复制。依据 [UsageRecord](https://github.com/MoonshotAI/kimi-code/blob/6451f1e056e90037bbf832f3578955cf8e55db64/packages/agent-core-v2/src/agent/usage/usageOps.ts)、生产启动的文件存储注入与旧版 Wire / TokenUsage 定义。当前 Kimi Code 的 MiniDB 是会话索引与搜索读模型，不替代 `agents/*/wire.jsonl` 的事件日志。

ZCode 读取原生 `ZCODE_SESSION_DB_PATH` / `ZCODE_SESSION_DB` 指定的绝对或 home 相对路径；项目相对路径不猜工作目录。此数据库独立于 OAuth 的 `.zcode/v2` 目录，不因切换凭据位置而臆造另一个数据库路径。CLI 原生逐请求表只保留 30 天，ASS 会在加密缓存中保留已读到且后来被原生清理的较早记录，最多覆盖近一年；首次接入前已清理的数据不能找回。字段与保留期依据 [ZCode usage.ts](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts)。

## 持久化与范围

筛选写入 preferences.json；用量元数据、匿名会话摘要、发现的目录及增量文件缓存写入 DPAPI 加密的 usage-history.enc.json，不存提示词、工具输出、邮箱或认证令牌。目录路径不发送到界面快照。文件签名不变时复用缓存；首页可见时每分钟检查，手动刷新立即检查。首次读取大目录在独立 Worker 中进行，不阻塞窗口交互。项目发现每批最多遍历 30,000 个目录，剩余目录保存到下一批；未扫完或有目录无法读取时标为部分记录，不因层级较深而永久跳过。

v0.1.16 从原生记录重建旧版的日粒度缓存，保留小时元数据；原生日志和账户配置不变。时区变更也会使缓存失效并重读，避免在旧时区的日期 / 小时上继续累计。

缺失记录显示为空，不补造历史曲线；读取失败保留上次快照及时间。受损、超过读取限制的来源显示“部分记录”，不能把当前数字当作完整账单。每类最多扫描 5,000 个 JSONL 文件，一次新增读取预算 3 GiB、单行 8 MiB；DSH 账本上限 32 MiB，整体读取超时 120 秒。这些保护不更改原文件。

这是本机可读历史，不是供应商服务器账单。删除的会话、其他设备、未落盘记录、未支持的历史格式与插件未记账的日期无法补回。
