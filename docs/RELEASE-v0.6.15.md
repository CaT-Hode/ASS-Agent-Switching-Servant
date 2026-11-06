# v0.6.15

- Model injection triggers native auto-compaction at 90% of the declared context. Codex keeps the full effective context window and uses its separate compact-token metadata; Claude Code receives its per-model `autoCompactWindow` setting, clamped to the CLI's supported 100K–1M range; OpenCode, pi, DSH, Kimi Code, and ZCode receive a 90% context limit for their native compaction logic.
- WSL Codex derives its 90% compact-token limit from the selected model's catalog entry instead of inheriting an unrelated or stale global value.
- OpenAI API keys no longer trigger guessed NewAPI/Sub2API balance requests against `api.openai.com`. The account and supplier views link to OpenAI's API Usage and Billing pages; an explicitly configured custom balance path remains available.
- Icon export decodes the SVG into Canvas instead of capturing a hidden window and checks visible artwork before updating image files.
- Validation: 20 critical tests and the production client build passed.
