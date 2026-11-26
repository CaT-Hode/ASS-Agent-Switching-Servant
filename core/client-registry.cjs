// Single source of truth for supported client IDs and capability flags.
const CLIENTS = {
  codex: {
    name: "Codex",
    route: "ASS",
    inject: true,
    legacyProxy: true,
    accountless: true,
    defaultModel: true,
    wsl: true,
    usage: "jsonl",
    conversations: true,
    restart: true,
    processTracked: true,
  },
  claude: {
    name: "Claude Code",
    route: "claude",
    inject: true,
    legacyProxy: true,
    accountless: true,
    defaultModel: true,
    wsl: true,
    usage: "jsonl",
    conversations: true,
    restart: true,
    processTracked: true,
  },
  opencode: {
    name: "OpenCode",
    route: "opencode",
    inject: true,
    legacyProxy: true,
    usage: "sqlite",
    restart: true,
    processTracked: true,
  },
  pi: {
    name: "pi",
    route: "pi",
    inject: true,
    legacyProxy: true,
    wsl: true,
    usage: "jsonl",
    processTracked: true,
  },
  dsh: {
    name: "DeepSeek Harness",
    route: "dsh",
    inject: true,
    legacyProxy: true,
    usage: "ledger",
    processTracked: true,
  },
  kimi: {
    name: "Kimi Code",
    inject: true,
    usage: "wire",
    processTracked: true,
  },
  zcode: {
    name: "ZCode",
    inject: true,
    usage: "sqlite",
    processTracked: true,
  },
  antigravity: {
    name: "Antigravity",
    route: "agy",
    inject: "launch-only",
    defaultModel: true,
    usage: "transcript",
    conversations: "readonly",
    processTracked: true,
  },
};

const CLIENT_IDS = Object.keys(CLIENTS);
const CLIENT_NAMES = Object.fromEntries(CLIENT_IDS.map((id) => [id, CLIENTS[id].name]));
const ids = (capability) =>
  CLIENT_IDS.filter((id) => (capability ? Boolean(CLIENTS[id][capability]) : true));

module.exports = { CLIENTS, CLIENT_IDS, CLIENT_NAMES, ids };
