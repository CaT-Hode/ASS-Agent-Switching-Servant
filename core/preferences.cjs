const fs = require("node:fs");
const path = require("node:path");
const { atomic } = require("./config.cjs");
const { CLIENT_IDS, ids: clientIds } = require("./client-registry.cjs");
const { WIDGET_GLASS_DEFAULTS, WIDGET_GLASS_LIMITS, WIDGET_MAX_RADIUS } = require("./request-widget-view.mjs");
const widgetColumns = { provider: true, throughput: true, cache: true, duration: true };
const widgetColumnKeys = ['harness', ...Object.keys(widgetColumns)];
const defaults = {
  view: "overview",
  theme: "system",
  client: "codex",
  provider: "official",
  officialService: "openai",
  providerOrder: [],
  quotaAccounts: {},
  quotaMonitor: { lowThreshold: 0, pinned: {} },
  antigravityHook: false,
  antigravityMcp: false,
  requestWidget: { enabled: false, width: 340, radius: WIDGET_MAX_RADIUS, rows: 5, materialVersion: 1, layoutVersion: 2,
    ...WIDGET_GLASS_DEFAULTS, showHeatmap: true, showUsage: false, quotaBars: [], columns: widgetColumns },
  requestMonitor: { range: "day", provider: "all", client: "all", status: "all", diagnostics: false, group: "requests" },
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
      const layoutUpgrade = saved.requestWidget && saved.requestWidget.layoutVersion !== 2;
      if (layoutUpgrade) {
        if (saved.requestWidget.width === undefined || saved.requestWidget.width === 380) saved.requestWidget.width = 340;
        saved.requestWidget.layoutVersion = 2;
      }
      this.state = this.validate(saved);
      if (upgrade || layoutUpgrade) atomic(this.file, JSON.stringify(this.state, null, 2));
    } catch {}
  }
  validate(input) {
    const next = { ...this.state };
    if (["system", "light", "dark"].includes(input.theme)) next.theme = input.theme;
    if (typeof input.antigravityHook === "boolean") next.antigravityHook = input.antigravityHook;
    if (typeof input.antigravityMcp === "boolean") next.antigravityMcp = input.antigravityMcp;
    if (input.requestMonitor && typeof input.requestMonitor === "object" && !Array.isArray(input.requestMonitor)) {
      const value = input.requestMonitor;
      next.requestMonitor = { ...defaults.requestMonitor, ...next.requestMonitor };
      for (const [key, options] of Object.entries({
        range: ["hour", "day", "week", "all"],
        client: ["all", "unknown", "legacy", "diagnostics", ...CLIENT_IDS],
        status: ["all", "running", "success", "failed", "observed"],
        group: ["requests", "model", "provider"],
      })) {
        if (options.includes(value[key])) next.requestMonitor[key] = value[key];
      }
      if (typeof value.provider === "string" && value.provider.length >= 1 && value.provider.length <= 160 &&
          !/[\x00-\x1f]/.test(value.provider)) next.requestMonitor.provider = value.provider;
      if (typeof value.diagnostics === "boolean") next.requestMonitor.diagnostics = value.diagnostics;
    }
    if (input.requestWidget && typeof input.requestWidget === 'object' && !Array.isArray(input.requestWidget)) {
      next.requestWidget = { ...defaults.requestWidget, ...next.requestWidget };
      const value = input.requestWidget;
      if (typeof value.enabled === 'boolean') next.requestWidget.enabled = value.enabled;
      if (typeof value.showHeatmap === 'boolean') next.requestWidget.showHeatmap = value.showHeatmap;
      if (typeof value.showUsage === 'boolean') next.requestWidget.showUsage = value.showUsage;
      if (Array.isArray(value.quotaBars)) {
        const ids = new Set();
        for (const id of value.quotaBars) {
          if (typeof id === "string" && /^[a-f0-9]{64}$/.test(id)) ids.add(id);
          if (ids.size === 2) break;
        }
        next.requestWidget.quotaBars = [...ids];
      }
      if (value.columns && typeof value.columns === 'object' && !Array.isArray(value.columns)) {
        next.requestWidget.columns = { ...next.requestWidget.columns };
        for (const key of widgetColumnKeys) {
          if (typeof value.columns[key] === 'boolean') next.requestWidget.columns[key] = value.columns[key];
        }
      }
      for (const [key, min, max] of [['width', 320, 640], ['radius', 8, WIDGET_MAX_RADIUS], ['rows', 1, 8], ['x', -100000, 100000], ['y', -100000, 100000], ['bottom', -100000, 100000]])
        if (Number.isInteger(value[key]) && value[key] >= min && value[key] <= max) next.requestWidget[key] = value[key];
      for (const [key, [min, max]] of Object.entries(WIDGET_GLASS_LIMITS)) {
        if (Number.isInteger(value[key]) && value[key] >= min && value[key] <= max) next.requestWidget[key] = value[key];
      }
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
        client: ["all", ...clientIds("usage")],
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
          "settings",
          "updates",
        ].includes(value)
      )
        continue;
      if (
        key === "client" &&
        ![...CLIENT_IDS, "cursor"].includes(value)
      )
        continue;
      next[key] = key === "view" ? ({ accounts: "clients", updates: "settings" }[value] ?? value) : value;
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
    if (input.quotaMonitor && typeof input.quotaMonitor === "object") {
      const { lowThreshold, pinned } = input.quotaMonitor;
      next.quotaMonitor = { ...next.quotaMonitor };
      if (Number.isInteger(lowThreshold) && lowThreshold >= 0 && lowThreshold <= 100)
        next.quotaMonitor.lowThreshold = lowThreshold;
      if (pinned && typeof pinned === "object" && !Array.isArray(pinned)) {
        next.quotaMonitor.pinned = { ...next.quotaMonitor.pinned };
        for (const [id, value] of Object.entries(pinned).slice(0, 500)) {
          if (id.length > 160 || !/^[a-z0-9:_-]+$/i.test(id)) continue;
          if (value === null) delete next.quotaMonitor.pinned[id];
          else if (typeof value === "string" && value.length <= 700 && value.startsWith("["))
            next.quotaMonitor.pinned[id] = value;
        }
      }
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
