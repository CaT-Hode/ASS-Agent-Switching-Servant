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
- [DeepSeek Harness llm-pi-ai](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-pi-ai)、[default model](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/agent-default-model)：隔离配置与模型接入。

这些链接用于说明兼容性依据，不代表原作者对 ASS 的认可。第三方订阅使用范围和计费遵循相应供应商条款。

## 视觉

桌面悬浮窗复用本地 `best-liquid-glass` skill 的独立桌面核心，源码位于 `native/desktop-glass`，不依赖 MifyQuota 的业务或本地项目路径。ASS 接入增加原生 Node-API 宿主、局部 GPU 材质网格、容量内 viewport 调整及同队列提交呈现；本轮问题与修复方法同步回 skill。使用 Windows SDK 的 DXGI Desktop Duplication、Windows.Graphics.Capture、D3D11 与 DirectComposition。

请求监控的信息布局参考 [ccflare](https://github.com/snipeship/ccflare) README 中的 dashboard 截图：顶部指标、请求趋势和分组表现；参考 [ccusage](https://github.com/ccusage/ccusage/tree/main/apps/ccusage) 将输入、输出、缓存读取和写入分列。界面与采集逻辑由 ASS 独立实现，没有引入上述工具的代码、依赖或账户信息。模型展示继续复用 ASS 的 `usageModelName`，仅按最后一级归并。

ASS logo 以用户指定的 `docs/assets/ass-reference-flat.png` 为参考，矢量底稿为 `public/ass-logo-reference.svg`，最终图形由 `scripts/brand-geometry.cjs` 生成。图标的源文件与统一导出方法见 [Logo 与图标导出](docs/LOGO.md)。其他图标使用 Lucide。系统字体与交互针对横向桌面窗口设计。

图像编辑提示词保留于 [logo 编辑记录](docs/LOGO.md)。
