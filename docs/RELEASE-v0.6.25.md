# ASS v0.6.25

- 修复用量总览漏读 WSL 项目归档的问题。已知项目内归档的 Claude Code `transcript.jsonl` 现在会参与统计，并按消息 ID 与原位置的记录去重。
- 修复 OpenAI Responses 和 Chat Completions 转成 Claude Messages 时丢失缓存读取字段的问题。新会话可以区分普通输入和缓存读取，输入与输出的总量不变。旧会话中未记录的缓存明细无法通过重扫恢复。
- Codex、Claude Code 和 pi 在检测到对应的 WSL 命令后，供应商名称旁会显示默认开启的 WSL 开关。可以只撤回指定供应商的 WSL 接入，Windows 接入保持原样。

提供 Windows x64 安装包与 SHA256 校验文件。
