# v0.3.32

Codex 客户端页增加醒目的“通过 ASS 启动 Codex”文字按钮，替换原来的小图标入口。

- 开启普通 OAuth 接入时，说明专用官方服务 HTTPS 通道可尝试处理 workspace settings 和 project chats 加载失败。
- 明确已运行的 Codex 需在任务结束后完全退出，再从 ASS 启动；原开始菜单 / 任务栏入口不会启用该进程专用通道。
- 启动结果直接显示在按钮附近。不会自动关闭 Codex 或中断任务。
- 未接入 / 无账号模式使用各自说明，不误称已启用官方服务修复，也不承诺解除账号、额度或官方网关限制。
- 无账号模式复用该桌面启动按钮，不再额外显示重复的“启动”按钮；命令行入口保留。

本轮仅调整启动入口与说明，没有修改 OAuth、网络中转或账号配置逻辑。

## 验证

- Vite 生产构建通过。
- 隔离 Electron + Playwright 的 3 项真实渲染回归通过：1100 / 1440 宽度的深浅色布局、启动请求 / 忙碌 / 成功及失败反馈、未接入 / 无账号模式和其他客户端入口保持。
- 最终包 147 个运行时文件与构建来源匹配；空配置打包版启动检查通过，页面错误为 0。
- 没有启动或关闭用户当前 Codex，没有重新验证或宣称当前账号的 workspace / project chats 已恢复。

## 手动更新本机

正常退出 ASS（包括托盘）后执行；不会强关客户端，也不清理旧包：

```powershell
Set-Location 'D:\CodexProj\ASS'
node .\scripts\local-release.cjs install
if ($LASTEXITCODE -eq 0) {
  Start-Process 'D:\CodexProj\ASS\release\current\ASS.exe'
}
```
