const fs = require("node:fs");
const path = require("node:path");
const { atomic } = require("./config.cjs");
const defaults = {
  view: "overview",
  theme: "system",
  client: "codex",
  provider: "official",
  officialService: "openai",
  providerOrder: [],
  quotaAccounts: {},
  requestWidget: { enabled: false, width: 380, radius: 36, rows: 5, materialVersion: 1 },
  conversations: { harness: "codex", pinned: false, scope: "projects", project: "", columns: { projects: 235, threads: 205 } },
  usage: { client: "all", range: "month", tab: "activity", group: "client" },
};
class Preferences {
  constructor(dataDir) {
    this.file = path.join(dataDir, "preferences.json");
    this.state = { ...defaults };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const upgrade = saved.requestWidget?.radius === 24 && !saved.requestWidget.materialVersion;
      if (upgrade) saved.requestWidget.radius = 36;
      this.state = this.validate(saved);
      if (upgrade) atomic(this.file, JSON.stringify(this.state, null, 2));
    } catch {}
  }
  validate(input) {
    const next = { ...this.state };
    if (["system", "light", "dark"].includes(input.theme)) next.theme = input.theme;
    if (input.requestWidget && typeof input.requestWidget === 'object') {
      next.requestWidget = { ...defaults.requestWidget, ...next.requestWidget };
      const value = input.requestWidget;
      if (typeof value.enabled === 'boolean') next.requestWidget.enabled = value.enabled;
      for (const [key, min, max] of [['width', 320, 640], ['radius', 8, 48], ['rows', 1, 8], ['x', -100000, 100000], ['y', -100000, 100000]])
        if (Number.isInteger(value[key]) && value[key] >= min && value[key] <= max) next.requestWidget[key] = value[key];
    }
    if (input.conversations && typeof input.conversations === "object") {
      next.conversations = { ...defaults.conversations, ...next.conversations };
      if (["codex", "claude", "dsh", "opencode", "pi"].includes(input.conversations.harness)) next.conversations.harness = input.conversations.harness;
      if (typeof input.conversations.pinned === "boolean") next.conversations.pinned = input.conversations.pinned;
      if (["native", "projects"].includes(input.conversations.scope)) next.conversations.scope = input.conversations.scope;
      if (typeof input.conversations.project === "string" && (/^[a-f0-9]{64}$/.test(input.conversations.project) || input.conversations.project === 'unassigned')) next.conversations.project = input.conversations.project;
      if (input.conversations.columns && typeof input.conversations.columns === 'object') {
        next.conversations.columns = { ...defaults.conversations.columns, ...next.conversations.columns };
        for (const key of ['projects', 'threads']) if (Number.isInteger(input.conversations.columns[key]) && input.conversations.columns[key] >= 170 && input.conversations.columns[key] <= 520)
          next.conversations.columns[key] = input.conversations.columns[key];
      }
    }
    if (input.usage && typeof input.usage === "object") {
      next.usage = { ...defaults.usage, ...next.usage };
      for (const [key, values] of Object.entries({
        client: ["all", "codex", "claude", "opencode", "pi", "dsh", "kimi", "zcode"],
        range: ["week", "month", "year"],
        tab: ["activity", "tokens", "quota"],
        group: ["client", "model"],
      }))
        if (values.includes(input.usage[key]))
          next.usage[key] = input.usage[key];
    }
    for (const key of ["view", "client", "provider", "officialService"]) {
      const value = input[key];
      if (
        typeof value !== "string" ||
        value.length > 160 ||
        /[\x00-\x1f]/.test(value)
      )
        continue;
      if (
        key === "view" &&
        ![
          "overview",
          "monitor",
          "providers",
          "clients",
          "conversations",
          "accounts",
          "diagnostics",
          "updates",
        ].includes(value)
      )
        continue;
      if (
        key === "client" &&
        !["codex", "claude", "opencode", "pi", "dsh", "cursor", "kimi", "zcode"].includes(value)
      )
        continue;
      next[key] = key === "view" && value === "accounts" ? "clients" : value;
    }
    if (Array.isArray(input.providerOrder)) {
      if (
        input.providerOrder.length > 5000 ||
        input.providerOrder.some(
          (id) =>
            typeof id !== "string" ||
            !id ||
            id.length > 250 ||
            /[\x00-\x1f]/.test(id),
        )
      )
        throw Error("供应商排序格式无效");
      next.providerOrder = [...new Set(input.providerOrder)];
    }
    if (
      input.quotaAccounts &&
      typeof input.quotaAccounts === "object" &&
      !Array.isArray(input.quotaAccounts)
    ) {
      next.quotaAccounts = {
        ...next.quotaAccounts,
        ...Object.fromEntries(
          Object.entries(input.quotaAccounts)
            .filter(
              ([id, value]) =>
                id.length <= 250 &&
                typeof value === "string" &&
                value.length <= 250 &&
                !/[\x00-\x1f]/.test(id + value),
            )
            .slice(0, 5000),
        ),
      };
    }
    return next;
  }
  update(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw Error("界面配置格式无效");
    const next = this.validate(input);
    atomic(this.file, JSON.stringify(next, null, 2));
    this.state = next;
    return next;
  }
}
module.exports = { Preferences };
