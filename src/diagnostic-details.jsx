import React from "react";
const timing = (ms) => Number.isFinite(ms) ? ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s` : "—";
const protocol = { "openai-responses": "Responses", "openai-chat": "Chat Completions", anthropic: "Messages" };
export function DiagnosticDetails({ result: r }) {
  return <div className="diagnostic-details">
    {r.stale && <small className="diagnostic-stale">配置已变化或目录待恢复 · 保留上次结果</small>}
    {r.supplierSaveFailed && <small className="diagnostic-stale">供应商保存失败，可检查磁盘后重新检测。</small>}
    {!r.ok && <div className="diagnostic-failure" role="note">
      <strong>{r.failure?.label || "旧版检测记录"}</strong>
      <p>{r.failure?.hint || "上次未保存详细错误原因，请重新检测；通用 502 不能判断 DNS、密钥或额度。"}</p>
    </div>}
    <dl className="diagnostic-measurements">
      <div title="发出检测请求至收到 HTTP 响应头；包含路由处理和上游等待"><dt>响应头</dt><dd>{timing(r.headersMs)}</dd></div>
      <div title="发出请求至第一个正文文本事件；不将握手、思考事件视为正文"><dt>首字延迟</dt><dd>{timing(r.firstTextMs)}</dd></div>
      <div title="检测请求开始至完整响应结束或失败"><dt>总耗时</dt><dd>{timing(r.ms)}</dd></div>
      <div><dt>{!r.ok && !r.failure ? "HTTP（旧记录）" : "上游 HTTP"}</dt><dd>{r.httpStatus || (r.failure ? "未收到" : "—")}</dd></div>
    </dl>
    <details className="diagnostic-extra"><summary>测试详情</summary>
      <dl className="diagnostic-measurements">
        {r.failure && <div><dt>失败阶段</dt><dd>{{ network: "DNS / 网络连接", upstream: "上游响应", stream: "响应流", local: "本机路由", unknown: "未明确" }[r.failure.layer]}</dd></div>}
        {r.failure?.code && <div><dt>错误代码</dt><dd className="mono">{r.failure.code}</dd></div>}
        {r.localStatus && <div title="本机路由响应，不代表供应商返回了相同状态"><dt>ASS 本地 HTTP</dt><dd>{r.localStatus}</dd></div>}
        <div><dt>上游协议</dt><dd>{protocol[r.protocol] || "—"}</dd></div>
        <div><dt>路径</dt><dd>{r.route === "native" ? "原生直连" : r.route === "router" ? "ASS 路由" : "—"}</dd></div>
        <div><dt>首事件</dt><dd>{timing(r.firstEventMs)}</dd></div>
        <div><dt>流接收</dt><dd>{timing(r.streamMs)}</dd></div>
        <div><dt>事件数</dt><dd>{r.eventCount ?? "—"}</dd></div>
        <div title="解析后的 SSE 事件 UTF-8 大小，不包含 HTTP 或 SSE 帧头"><dt>事件数据</dt><dd>{Number.isFinite(r.responseBytes) ? `${(r.responseBytes / 1024).toFixed(1)} KiB` : "—"}</dd></div>
        <div><dt>输入 / 输出 token</dt><dd>{r.inputTokens ?? "—"} / {r.outputTokens ?? "—"}</dd></div>
        <div><dt>结束阶段</dt><dd>{{ connect: "建立连接", headers: "响应头", stream: "流接收", complete: "完整结束" }[r.phase] || "—"}</dd></div>
      </dl>
    </details>
  </div>;
}
