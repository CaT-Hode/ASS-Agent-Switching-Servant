# ASS 0.5.1

新增 Codex、Claude Code 和 pi 的 WSL 自动同步。入口在各客户端的“客户端设置”，默认发行版为 Ubuntu，可检测并切换发行版。

- 跟随 Windows 已应用的配置，五秒内检查模型变动，并定期恢复本地转接；保存但未同步的草稿不会应用到 WSL。
- Codex 使用 Linux 模型目录与本地网关凭据，继承模型、思维强度和上下文设置，Windows 官方登录仍由 ASS 使用。
- Claude Code 继承模型列表、默认模型、Auto Mode 审查模型及 1M 标识。
- pi 继承 API 模型与原生协议配置，公开地址直连；Windows 本机 HTTP 地址自动转接。本机 HTTPS 地址需配置为 Linux 可访问的地址。
- NAT 下通过 Windows interop 连接本机 ASS，无需开放外部监听、修改网络模式或关闭 WSL。
- 仅管理模型与路由字段，原字段加密备份；关闭开关可恢复。Linux 与 Windows 各自的会话、权限、MCP 和 Hook 保留。

发行版需要 Python 3、可用的 Windows interop，以及相应 Linux CLI。ASS 必须运行；新开 CLI 会话后加载设置。

本地更新使用保留运行进程的安装方式，新版在下次正常启动 ASS 时启用。
