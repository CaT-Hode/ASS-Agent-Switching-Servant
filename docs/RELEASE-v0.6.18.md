# v0.6.18

- Codex keeps the `openai` provider identity for normal, accountless, and isolated model launches. Inference continues through the local ASS route, so switching login state no longer changes the provider required to resume an existing chat.
- Accountless sync preserves existing ChatGPT or native API credentials. When no native credential exists, ASS adds a local API credential through the encrypted connection transaction and restores the original file on disconnect. A later native login is preserved.
- The old-chat repair action now repairs provider bindings without requiring ChatGPT login. It retains the selected model and conversation history; prediction eligibility remains dependent on native ChatGPT login.
- Local fallback credentials are excluded from native-account discovery. Third-party requests use the supplier credential, and accountless mode continues to reject official-model inference.
- Validation: 23 critical tests and the production client build passed. An isolated installed Codex app-server created a legacy ASS chat, migrated it without login, resumed it, created a new chat, and retained archive visibility. All three inference turns used a synthetic supplier behind the local router.
