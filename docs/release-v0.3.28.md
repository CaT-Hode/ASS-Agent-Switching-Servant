# v0.3.28

补齐新版 Codex 的官方初始化请求中转，确保 workspace/account 状态检查与普通 Responses 请求使用同一套本地 ASS 接入。

- 严格中转 Codex 只读初始化接口，包括 `/settings/user`、`/accounts/check`、`/config/bundle`、`/profiles/me` 和 `/usage`；不开放任意路径、任务创建或修改型官方接口。
- 普通 Codex OAuth 接入使用本地 `clients/ASS/backend-api/` relay，并在中转官方初始化请求时重新使用当前 OAuth 凭据和账户 ID；无账号模式不触碰官方账户请求。
- 保留上游状态码、正文、request ID、Cloudflare 网关标识、限流信息和有限诊断字段，避免把真实的 403/网关失败误报为普通 ASS 错误。
- 透传必要的 Codex User-Agent、语言、扩展头和会话追踪信息，同时过滤 Cookie、代理凭据、本地控制头和第三方供应商凭据。
- 保持 SSE 心跳、事件 ID、换行格式和原生失败事件；请求日志只记录脱敏后的关联 ID 与有限上游诊断，不保存请求正文、Cookie 或 OAuth。
- Codex 接入状态会检查 workspace relay 是否已写入；未同步时显示待同步，而不是误报已生效。

本轮验证覆盖 Electron session.fetch 网络栈、gzip 请求与错误响应、原始 SSE、凭据隔离和 Codex bootstrap relay。真实上游仍可能因出口、Cloudflare 或官方 workspace 策略返回 403；ASS 保留这些证据供继续定位，不绕过官方安全校验。
