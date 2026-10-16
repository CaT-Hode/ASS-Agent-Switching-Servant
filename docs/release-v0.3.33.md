# v0.3.33

修复 v0.3.32 的 Codex 桌面启动按钮可能完全不显示。

- 根因：按钮依赖 `client.desktop`，但客户端发现只识别了 Codex CLI，没有覆盖 Windows 商店版桌面。上一轮界面测试预设桌面已识别，没有覆盖实际缺失状态。
- Codex 客户端页始终显示“通过 ASS 启动 Codex”；未识别桌面时给出具体提示，不隐藏入口。
- 增加 OpenAI.Codex 商店安装目录和受限目录下的用户注册发现，通过 Codex 官方桌面包元数据区分 ChatGPT.exe / Codex.exe 与 CLI。
- 已保存 Codex CLI 入口不再阻止启动时发现桌面端；启动按钮遇到未识别 / 过期缓存时自动重新检测。
- 优先使用当前用户注册的商店版本，避免回滚后误选残留新版本目录；同一安装内的 Codex.exe 辅助入口归并到真实桌面入口，不重复显示。
- 只读取安装元数据，不修改账号、OAuth、接入配置，不自动关闭任何客户端。

## 验证

- 34 项客户端发现 / 账户管理 / 真实 Electron 界面相关回归通过；归并桌面别名后，18 项发现回归再次通过。
- 本机只读发现已确认 CLI 与当前注册的 Codex 商店桌面各一项。
- 最终包 147 个运行时文件与构建来源匹配；独立空账户环境中的实际打包版确认 `codexLaunchVisible: true`、`codexDesktopDetected: true`，页面错误为 0。
- 未启动或关闭用户真实 Codex，未验证或宣称现有会话的 workspace / project chats 已恢复。
- 用户选择暂时保留 ASS 运行，新包已准备，但本机 current 仍指向 v0.3.32。

## 手动更新本机

正常退出 ASS（包括托盘）后执行；不会强关客户端，也不清理旧包：

```powershell
Set-Location 'D:\CodexProj\ASS'
node .\scripts\local-release.cjs install
if ($LASTEXITCODE -eq 0) {
  Start-Process 'D:\CodexProj\ASS\release\current\ASS.exe'
}
```
