# v0.3.31

修复 Codex 启动 / 切换模型后被误判接入异常，以及桌面项目列表中转的认证目标问题。

- ASS 不再逐字比对整个 Codex 管理区段。`model` 与 `model_reasoning_effort` 作为原生可写偏好，允许模型切换及 TOML 等价格式变化；供应商、地址、协议和认证配置仍严格验证。修复接入时保留当前原生模型选择。
- Codex 将通知、插件、MCP、桌面偏好等写入管理注释范围内时，不再误判这些字段归 ASS 所有。验证、修复、重新同步和断开均保留它们；正常写回不触发配置重写。
- 模型草稿尚未同步，不再阻止可信的已应用官方服务通道启动。
- 撤掉进程级 `CODEX_API_BASE_URL` 改写。桌面保留原始官方 URL，通过其原生 workspace routing 将请求送到本机 HTTPS；不修改或绕过 `Refusing to attach authentication to non-OpenAI URL` 保护。
- 已启用普通 OAuth 接入时，ASS 启动会主动准备 / 恢复专用 HTTPS 服务，不再只在已有证书记录时恢复。状态快照记录中转是否运行、端口及最近一次请求的时间和状态，不记录项目名称或内容。
- 无法可靠确认 Codex 进程状态时，拒绝重复启动并给出提示。

## 验证边界

针对已安装的 Codex Desktop，使用独立临时用户资料和 OAuth 副本，真实桌面进程经 ASS 读取项目索引和项目对话列表。仅允许 GET/HEAD 元数据请求，其他请求由测试阻止，没有发送模型推理、没有关闭用户当前桌面、没有修改原生 auth/config。此验证比单独模拟 Electron fetch 更接近实际启动链路，但不代表用户当前仍在运行的旧进程已切换通道。

启用方法：任务结束后正常退出 Codex，再从新版 ASS 的客户端页面打开桌面端，或使用接入菜单中自己确认的重启选项。直接使用原来的 Codex 开始菜单入口启动仍走原生官方网络，不会自动继承 ASS 的进程专用通道。

本轮结果：943 项自动测试通过。最终包的 147 个运行时文件与源码匹配；真实已安装桌面进程使用最终包模块启动后，项目索引和 3 次项目对话列表请求均返回 200 JSON，原生新增配置的归属检查通过；测试正常退出，原窗口保留，原 auth/config 哈希未变，推理请求为 0。独立空配置的 ASS 桌面启动检查也通过。

## 手动更新本机

正常退出 ASS（包括托盘）后执行；不会强关客户端，也不会清理旧包：

```powershell
Set-Location 'D:\CodexProj\ASS'
node .\scripts\local-release.cjs install
if ($LASTEXITCODE -eq 0) {
  Start-Process 'D:\CodexProj\ASS\release\current\ASS.exe'
}
```
