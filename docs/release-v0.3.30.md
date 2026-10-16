# v0.3.30

为 Codex 的项目对话、账户和官方服务提供专用 HTTPS 中转。

- 普通 OAuth 接入生效后，从 ASS 打开或通过接入菜单重启 Codex，会使用进程专用的 HTTPS 官方服务地址。项目列表等请求使用 ASS 的 Chromium 系统网络通道；模型请求仍使用原有路由。
- 保持全局 `chatgpt_base_url` 与 OAuth 文件不变。Codex 从自身开始菜单直接启动时仍使用原生官方网络；专用中转只随 ASS 启动的进程生效。已运行的 Codex 必须在任务完成后重新打开才能启用。
- 本机服务仅监听 `127.0.0.1`，证书私钥加密保存。原生 Codex 使用专用 CA，桌面网络使用精确的证书公钥固定；不写入 Windows 信任库，不关闭全局 TLS 验证。已有额外 CA 合并保留。
- HTTPS 端口与证书持久化，ASS 再次启动时恢复原端口，避免已打开的 Codex 仍引用旧地址。若端口被其他进程占用则明确报错，不静默换端口。
- 只将 `/backend-api/` 请求送往固定官方域名，保留实际 OAuth、上游状态码、JSON 列表、错误和分页。不会将失败请求伪造为空项目列表。无账号模式不启用官方服务中转。
- 官方服务请求纳入 Codex 接入的活动计数、取消和关闭保护。原始 HTML 403 仍保留诊断；此功能不保证消除所有官方网关拒绝。

使用方法：更新 ASS 后，在任务完成时通过 Codex 接入菜单重启，或完全退出 Codex，再在 ASS 客户端页面点击“打开桌面端”。不要在当前任务运行中强制重启。

## 本机验证

- 全量自动测试：939 通过，0 失败。
- 最终包校验：147 个运行时文件与源码一致，没有私有配置或密钥形态内容混入。
- 使用最终包中的模块、临时配置与当前 OAuth 副本，真实 Codex app-server 的 `account/read` 保持 ChatGPT 账户可见，并接受本机 HTTPS workspace origin。
- Electron 使用与启动器相同的精确 SPKI 固定参数，请求实际官方账户接口与已观察到的项目列表接口，均得到 200 JSON；原生 auth/config 哈希未变，推理请求数为 0。
- 最终包桌面空配置启动通过，无页面错误。

以上不等同于已确认用户正在运行的 Codex 侧栏恢复。为保留任务，测试没有关闭或重启该窗口；正常重新打开后仍需观察实际侧栏。

## 手动替换本机

先正常退出 ASS（包括托盘），再执行；脚本发现 ASS 仍在运行会拒绝替换，不会强制关闭进程，也不会清除旧包。

```powershell
Set-Location 'D:\CodexProj\ASS'
node .\scripts\local-release.cjs install
if ($LASTEXITCODE -eq 0) {
  Start-Process -FilePath 'D:\CodexProj\ASS\release\current\ASS.exe'
}
```
