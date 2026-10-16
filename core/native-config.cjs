const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { NativeFields, document, read, hash } = require("./native-fields.cjs");
const { nativeLocations } = require("./credential-status.cjs");
const { endpoint } = require("./models.cjs");
const { protocolEndpoint } = require("./provider-transport.cjs");
const { injectionCatalog, modelRef } = require("./client-policy.cjs");
const { target: kimiTarget } = require("./kimi-config.cjs");
const zcode = require("./zcode-config.cjs");
const dsh = require("./dsh-config.cjs");
const { sameApi } = require("./native-api-identity.cjs");
const { OUTPUT_DEFAULTS_VERSION, upgradeNativeOutput } = require('./output-tokens.cjs');
const DIRECT = ["opencode", "pi", "dsh", "kimi", "zcode"];
const APIS = {
  "openai-responses": "openai-responses",
  "openai-chat": "openai-completions",
  anthropic: "anthropic-messages",
};
const NPMS = {
  "openai-responses": "@ai-sdk/openai",
  "openai-chat": "@ai-sdk/openai-compatible",
  anthropic: "@ai-sdk/anthropic",
};
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const providerId = (p, protocol) =>
  "ass-" +
  createHash("sha256").update(p.id).digest("hex").slice(0, 16) +
  "-" +
  {
    "openai-responses": "responses",
    "openai-chat": "chat",
    anthropic: "messages",
  }[protocol];
// pi interprets commands/environment variables even in auth.json API keys.
const piLiteral = (value) =>
  String(value)
    .replaceAll("$", () => "$$")
    .replace(/^!/, "$!");

function locations(harness, manager) {
  if (harness === "kimi") return kimiTarget(manager);
  if (harness === "zcode") return zcode.target(manager, (file) => {
    const text = read(file);
    if (text === null) return {};
    try { return document(text, "json").data; } catch { return {}; }
  });
  const env = manager.nativeEnv,
    home = manager.nativeHome;
  if (harness === 'dsh') {
    const resolved = require('./dsh-locations.cjs').locations({ home, env, override: manager.state.credentialHomes[harness], launcher: manager.launcher?.(harness) });
    if (resolved.issue) throw Error(resolved.issue);
  }
  const dir = (manager.nativeLocations ? manager.nativeLocations(harness) : nativeLocations(
    harness,
    home,
    env,
    manager.state.credentialHomes[harness],
  ))[0];
  if (harness === "opencode") {
    const configDir = path.join(
      env.XDG_CONFIG_HOME || path.join(home, ".config"),
      "opencode",
    );
    const candidates = ["opencode.jsonc", "opencode.json", "config.json"].map(
      (f) => path.join(configDir, f),
    );
    const config = env.OPENCODE_CONFIG
      ? path.resolve(env.OPENCODE_CONFIG)
      : candidates.find((f) => fs.existsSync(f)) || candidates[0];
    return { dir, config, auth: path.join(dir, "auth.json"), major: require('./opencode-version.cjs').version(manager.launcher?.('opencode'), dir) };
  }
  if (harness === "pi")
    return {
      dir,
      config: path.join(dir, "models.json"),
      auth: path.join(dir, "auth.json"),
      settings: path.join(dir, "settings.json"),
    };
  if (harness === "dsh") return dsh.target(dir, manager);
  throw Error("此客户端不使用原生 API 配置接入");
}
function profileLocations(harness, dir, base) {
  if (harness === "opencode") return { dir: path.join(dir, "data/opencode"),
    config: path.join(dir, "config/opencode/opencode.jsonc"), auth: path.join(dir, "data/opencode/auth.json"), major: base?.major || 1 };
  if (harness === "pi") return { dir, config: path.join(dir, "models.json"),
    auth: path.join(dir, "auth.json"), settings: path.join(dir, "settings.json") };
  if (harness === "dsh") return dsh.profileTarget(dir, base || { format: "yaml" });
  throw Error("不支持的原生配置目录");
}
function baseUrl(harness, p, wire) {
  const url = protocolEndpoint(p, wire).replace(
    /\/(?:responses|chat\/completions|messages)$/,
    "",
  );
  // Anthropic's own SDK appends /v1/messages; the AI SDK appends /messages.
  return wire === "anthropic" && !["opencode", "zcode"].includes(harness)
    ? url.replace(/\/v1$/, "")
    : url;
}
function reasoning(model) {
  return Object.fromEntries(
    LEVELS.map((level) => [
      level,
      model.efforts.includes(level) ? level : null,
    ]),
  );
}
function compose(harness, manager, selection, targetOverride) {
  const target = targetOverride || locations(harness, manager),
    fields = [];
  if (harness === "zcode") {
    const text = read(target.config);
    if (text !== null) zcode.validate(document(text, "json").data);
  }
  const field = (file, format, keys, value, extra = {}) =>
    fields.push({ harness, file, format, path: keys, value, ...extra });
  const providers = manager.effectiveProviders?.(harness) || manager.getState().providers;
  const settings = manager.state.injections?.[harness] || {};
  if (harness === 'dsh') for (const p of providers.filter(p => p.enabled && p.apiKey && !(settings.excludedProviders || []).includes(p.id)))
    for (const m of p.models.filter(m => m.enabled && !(settings.excluded || []).includes(modelRef(p.id, m.model)))) dsh.reasoning(m);
  const managedCatalog = manager.injection?.(harness, undefined, targetOverride ? { target } : {})?.models;
  const catalog = Array.isArray(managedCatalog)
    ? managedCatalog
    : injectionCatalog(harness, providers, settings);
  const included = new Set(catalog.filter((m) => m.included).map((m) => m.ref));
  const selectedRef = selection?.model && selection?.account
    ? modelRef(selection.account.replace(/^api:/, ""), selection.model)
    : undefined;
  let selected;
  for (const p of providers) {
    const grouped = Map.groupBy(
      p.models.filter((m) => included.has(modelRef(p.id, m.model))),
      (m) => m.wireApi,
    );
    for (const [wire, models] of grouped) {
      if (!APIS[wire]) throw Error("原生接入不支持此模型协议");
      const id = providerId(p, wire),
        base = baseUrl(harness, p, wire);
      const headers = p.extraHeaders || {};
      if (harness === "opencode") {
        if (target.major === 2 && require('./opencode-version.cjs').credentials(target.dir)?.some(r => r.integrationID === id &&
          (r.value.type !== 'key' || r.value.key !== p.apiKey || Object.keys(r.value.metadata || {}).length || Object.keys(r.value.configuration || {}).length)))
          throw Error('OpenCode 接入供应商已有原生 credential，可能覆盖 ASS 密钥；请先在原生客户端整理该供应商账户');
        const value = {
          name: p.name,
          npm: NPMS[wire],
          options: { baseURL: base, headers, ...(target.major === 2 ? { apiKey: p.apiKey } : {}) },
          models: Object.fromEntries(
            models.map((m) => [
              m.model,
              {
                name: m.displayName,
                limit: { context: m.contextWindow, output: m.maxOutputTokens },
                reasoning: m.efforts.length > 0,
                ...(wire === "anthropic"
                  ? {}
                  : {
                      options: { reasoningEffort: m.defaultEffort },
                      variants: Object.fromEntries(
                        m.efforts.map((e) => [e, { reasoningEffort: e }]),
                      ),
                    }),
              },
            ]),
          ),
        };
        // OpenCode substitutes these anywhere in config, not just API key fields.
        if (/\{(?:env|file):/.test(JSON.stringify(value)))
          throw Error(
            "原生 OpenCode 配置不接受导入值中的 env/file 插值，请先改为字面值",
          );
        field(target.config, "jsonc", ["provider", id], value, target.major === 2 ? { credentialProvider: id } : {});
        if (target.major !== 2) field(
          target.auth,
          "json",
          [id],
          { type: "api", key: p.apiKey },
          { credentialProvider: id },
        );
      } else if (harness === "pi") {
        field(target.config, "json", ["providers", id], {
          baseUrl: base,
          api: APIS[wire],
          // pi requires a nonempty apiKey declaration for custom providers,
          // then prefers auth.json at request time. An unset variable fails
          // closed if that credential is removed; no duplicate plaintext key.
          apiKey: "$ASS_PI_AUTH_REQUIRED",
          headers: Object.fromEntries(
            Object.entries(headers).map(([k, v]) => [k, piLiteral(v)]),
          ),
          models: models.map((m) => ({
            id: m.model,
            name: m.displayName,
            contextWindow: m.contextWindow,
            maxTokens: m.maxOutputTokens,
            input: ["text"],
            reasoning: m.efforts.length > 0,
            thinkingLevelMap: reasoning(m),
          })),
        });
        field(
          target.auth,
          "json",
          [id],
          { type: "api_key", key: piLiteral(p.apiKey) },
          { credentialProvider: id },
        );
      } else if (harness === "zcode") {
        const apiType = wire === "openai-chat" ? "openai-chat-completions" : APIS[wire];
        field(target.config, "json", zcode.PROVIDERS, { providerId: id, providerName: p.name, enabled: true,
          config: { group: "standard-personal", visibility: "visible", access: { type: "api-key", apiKey: p.apiKey },
            api: { type: apiType, baseUrl: base, headers }, personalModelIds: models.map((m) => m.model) } },
        { selector: { providerId: id }, credentialProvider: id });
        for (const m of models) field(target.config, "json", zcode.MODELS,
          { providerId: id, modelId: m.model, config: zcode.modelConfig(m) },
          { selector: { providerId: id, modelId: m.model } });
      } else if (harness === "kimi") {
        const legacy = target.variant === "legacy";
        field(target.config, "toml", ["providers", id], {
          type: wire === "anthropic" ? "anthropic" : wire === "openai-responses" ? "openai_responses" : legacy ? "openai_legacy" : "openai",
          base_url: base,
          api_key: p.apiKey,
          ...(Object.keys(headers).length ? { custom_headers: headers } : {}),
        }, { credentialProvider: id });
        for (const m of models) {
          const alias = id + "-" + createHash("sha256").update(m.model).digest("hex").slice(0, 16);
          field(target.config, "toml", ["models", alias], {
            provider: id, model: m.model, display_name: m.displayName,
            max_context_size: m.contextWindow,
            ...(m.efforts.length ? { capabilities: ["thinking"] } : {}),
            ...(!legacy ? { max_output_size: m.maxOutputTokens, support_efforts: m.efforts,
              ...(m.efforts.length ? { default_effort: m.defaultEffort } : {}) } : {}),
          });
        }
      } else {
        field(target.config, target.format || "yaml", ["llm-pi-ai", "providers", id], {
          displayName: p.name,
          baseURL: base,
          api: APIS[wire],
          headers,
          models: models.map((m) => ({
            id: m.model,
            name: m.displayName,
            contextWindow: m.contextWindow,
            maxTokens: m.maxOutputTokens,
            input: ["text"],
            reasoningEfforts: dsh.reasoning(m),
          })),
        });
        field(
          target.auth,
          "yaml",
          ["records", "llm-pi-ai/" + id],
          { kind: "api-key", key: p.apiKey },
          { credentialProvider: id },
        );
      }
      const m = models.find((m) => modelRef(p.id, m.model) === selectedRef);
      if (m) selected = { id, model: m };
    }
  }
  if (harness === "dsh" && fields.length) {
    const credentials = document(read(target.auth), "yaml").data;
    if (credentials.version !== undefined && credentials.version !== 1)
      throw Error("DSH 凭据格式不是 version: 1，请先用 DSH 完成升级");
    // Structural marker is deliberately retained on disconnect, so newly added
    // native records remain readable even if ASS originally created the file.
    if (credentials.version !== 1)
      field(target.auth, "yaml", ["version"], 1, { retain: true });
  }
  if (selected) {
    const { id, model: m } = selected;
    if (harness !== "opencode" && !LEVELS.includes(m.defaultEffort))
      throw Error(
        `${harness} 原生思维档位最高为 max；请修改所选模型的默认档位`,
      );
    if (harness === "opencode")
      field(target.config, "jsonc", ["model"], id + "/" + m.model, {
        replace: true,
      });
    if (harness === "pi") {
      field(target.settings, "json", ["defaultProvider"], id, {
        replace: true,
      });
      field(target.settings, "json", ["defaultModel"], m.model, {
        replace: true,
      });
      field(
        target.settings,
        "json",
        ["defaultThinkingLevel"],
        m.defaultEffort,
        { replace: true },
      );
      field(
        target.settings,
        "json",
        ["modelThinkingLevels", id + "/" + m.model],
        m.defaultEffort,
      );
    }
    if (harness === "dsh") {
      for (const [key, value] of Object.entries({
        provider: id,
        model: m.model,
        reasoningEffort: m.defaultEffort,
      }))
        field(target.config, target.format || "yaml", ["agent-default-model", key], value, {
          replace: true,
        });
    }
  }
  if (selectedRef && !selected) throw Error("默认接入模型不可用，请重新选择或保留客户端默认模型");
  return { target, fields, selected, modelCount: included.size,
    nativeModelCount: catalog.filter((m) => m.native).length };
}

class NativeConfig {
  constructor(dataDir, crypto, manager) {
    this.fields = new NativeFields(dataDir, crypto);
    this.manager = manager;
    this.errors = {};
    this.activated = new Set(this.fields.entries.map((e) => e.harness));
    this.migrateOutputDefaults();
  }
  migrateOutputDefaults() {
    if (this.fields.error || this.fields.state.pending || this.fields.state.outputTokenDefaultsVersion === OUTPUT_DEFAULTS_VERSION) return;
    const equal = require('node:util').isDeepStrictEqual;
    let failed = false;
    for (const id of new Set(this.fields.entries.map(e => e.harness))) {
      const entries = this.fields.entries.filter(e => e.harness === id);
      const fields = entries.map(e => ({ ...e, value: upgradeNativeOutput(e) }));
      if (fields.every((f, i) => equal(f.value, entries[i].after.value))) continue;
      try { this.fields.apply(id, fields); }
      catch (error) { failed = true; this.errors[id] = '默认输出上限迁移未完成：' + error.message; }
    }
    if (!failed) this.fields.save({ ...this.fields.state, outputTokenDefaultsVersion: OUTPUT_DEFAULTS_VERSION });
  }
  isDirect(id) {
    return DIRECT.includes(id);
  }
  list(ids) {
    return [
      ...new Set(
        this.fields.entries
          .filter((e) => ids.includes(e.harness))
          .map((e) => e.file),
      ),
    ];
  }
  owns(id, file, provider) {
    return this.fields.owns(id, file, provider);
  }
  desired(id, selection) {
    if (["kimi", "zcode"].includes(id) && selection) throw Error("请在原生客户端内选择模型；ASS 不修改默认模型");
    const plan = compose(id, this.manager, selection);
    if (["kimi", "zcode"].includes(id) && this.fields.entries.some((e) => e.harness === id &&
        path.resolve(e.file).toLowerCase() !== path.resolve(plan.target.config).toLowerCase()))
      throw Error(`${id === "kimi" ? "Kimi" : "ZCode"} 目标目录已变化，请先断开接入，再切换目录或版本`);
    for (const dir of this.manager.state.nativeProfileTargets?.[id] || []) {
      this.validateProfile(id, dir);
      const profile = compose(id, this.manager, undefined, profileLocations(id, dir, plan.target));
      plan.fields.push(...profile.fields);
    }
    // Keep a structural marker owned across subsequent syncs.
    for (const e of this.fields.entries.filter(
      (e) => e.harness === id && e.retain,
    )) {
      if (
        (Object.values(plan.target).includes(e.file) || plan.fields.some((d) => d.file === e.file)) &&
        !plan.fields.some(
          (d) =>
            d.file === e.file &&
            JSON.stringify(d.path) === JSON.stringify(e.path),
        )
      )
        plan.fields.push({ ...e, value: e.after.value });
    }
    return plan;
  }
  validateProfile(id, dir) {
    const base = path.resolve(this.manager.dataDir, "clients", id);
    if (typeof dir !== "string" || path.dirname(path.resolve(dir)).toLowerCase() !== base.toLowerCase() || !/^[a-f0-9]{24}$/.test(path.basename(dir)))
      throw Error("独立账户配置目录无效");
  }
  syncProfile(id, dir) {
    this.validateProfile(id, dir);
    const existing = this.fields.entries.filter((e) => e.harness === id)
      .map((e) => ({ ...e, value: e.after.value }));
    // Launching an account is not permission to apply pending model edits.
    // New homes inherit the last explicitly applied native fields, and existing
    // homes keep them unchanged even while a newer draft awaits confirmation.
    this.fields.plan(id, existing);
    const targets = this.manager.state.nativeProfileTargets ||= {};
    targets[id] ||= [];
    if (targets[id].includes(dir)) return;
    const source = locations(id, this.manager), target = profileLocations(id, dir, source);
    const { activeApis } = this.manager.discoverNativeApis(id, undefined, { target });
    const duplicateIds = new Set();
    for (const entry of existing.filter((e) => e.file === source.config && !e.replace)) {
      const pid = id === "dsh" ? entry.path[2] : entry.path[1];
      const auth = existing.find((e) => e.file === source.auth &&
        (e.path[0] === pid || e.path[1] === "llm-pi-ai/" + pid));
      const value = entry.value;
      const apiKey = auth?.value.key || value?.options?.apiKey;
      if (apiKey && value && activeApis.some((api) => sameApi(api, {
        baseUrl: value.baseURL || value.baseUrl || value.options?.baseURL,
        apiKey, extraHeaders: value.headers || value.options?.headers,
      }))) duplicateIds.add(pid);
    }
    const fields = existing.flatMap((e) => {
      const key = ["config", "auth", "settings"].find((k) => source[k] === e.file);
      if (!key) return [];
      if (e.path.some((part) => duplicateIds.has(part) || typeof part === "string" &&
          part.startsWith("llm-pi-ai/") && duplicateIds.has(part.slice(10)))) return [];
      if (id === "dsh" && key === "auth" && e.path.join("/") === "version" && document(read(target.auth), "yaml").data.version === 1) return [];
      return [{ ...e, file: target[key] }];
    });
    if (!fields.length) return;
    const desired = [...existing, ...fields];
    const old = [...targets[id]];
    targets[id].push(dir);
    try { this.manager.save(); this.fields.apply(id, desired); }
    catch (error) { targets[id] = old; this.manager.save(); throw error; }
    this.activated.add(id);
  }
  preflight(ids, enabled) {
    for (const id of ids.filter((id) => this.isDirect(id))) {
      if (id === "dsh" && this.dshRelocations().length) throw Error("DSH 已升级配置格式，请使用一键修复迁移到当前 profile");
      if (this.fields.state.pending) {
        this.fields.recoveryCheck();
        continue;
      }
      const plan = enabled ? this.desired(id) : null;
      if (plan && !plan.modelCount && !plan.nativeModelCount && !this.activated.has(id) && !this.manager.options.isConnected?.(id))
        throw Error("没有可接入的模型，请先开启供应商及其兼容模型");
      this.fields.plan(id, plan ? plan.fields : this.retained(id));
    }
  }
  retained(id) {
    return this.fields.entries
      .filter((e) => e.harness === id && e.retain)
      .map((e) => ({ ...e, value: e.after.value }));
  }
  sync(id, selection) {
    if (!this.isDirect(id)) return;
    try {
      if (id === "dsh" && this.dshRelocations().length) throw Error("DSH 已升级配置格式，请使用一键修复迁移到当前 profile");
      this.fields.recover();
      const plan = this.desired(id, selection);
      if (!plan.modelCount && !plan.nativeModelCount && !this.activated.has(id) && !this.manager.options.isConnected?.(id))
        throw Error("没有可接入的模型，请先开启供应商及其兼容模型");
      this.fields.apply(id, plan.fields);
      this.activated.add(id);
      delete this.errors[id];
      return plan;
    } catch (error) {
      this.errors[id] = error.message;
      throw error;
    }
  }
  restore(ids) {
    for (const id of ids.filter((id) => this.isDirect(id))) {
      this.fields.apply(id, this.retained(id));
      // Retained structural markers are no longer owned and contain no secret.
      this.fields.save({
        entries: this.fields.entries.filter((e) => e.harness !== id),
        pending: null,
      });
      delete this.errors[id];
      this.activated.delete(id);
      if (this.manager.state.nativeProfileTargets) {
        delete this.manager.state.nativeProfileTargets[id];
        this.manager.save();
      }
    }
  }
  repairPlan(id) {
    if (!this.isDirect(id)) throw Error("此客户端暂不支持受管字段修复");
    const changes = id === "dsh" ? this.dshRelocations() : [];
    if (changes.length) {
      const plan = this.fields.relocationPlan(id, changes);
      return { files: plan.files.map((f) => f.file), migration: true, routeOnly: !plan.files.length };
    }
    const plan = this.fields.repairPlan(id);
    return { files: plan.files.map((f) => f.file) };
  }
  repair(id) {
    if (!this.isDirect(id)) throw Error("此客户端暂不支持受管字段修复");
    const changes = id === "dsh" ? this.dshRelocations() : [];
    const result = changes.length ? this.fields.relocate(id, changes) : this.fields.repair(id);
    delete this.errors[id];
    this.activated.add(id);
    return result;
  }
  dshRelocations() {
    const base = locations("dsh", this.manager);
    if (base.format !== "dsh-patch") return [];
    return this.fields.entries.filter((e) => e.harness === "dsh" && e.format === "yaml" &&
      path.basename(e.file) === "settings.yaml" && ["llm-pi-ai", "agent-default-model"].includes(e.path[0]))
      .map((from) => {
        const dir = path.dirname(from.file);
        if (path.resolve(dir).toLowerCase() !== path.resolve(base.dir).toLowerCase()) this.validateProfile("dsh", dir);
        const target = path.resolve(dir).toLowerCase() === path.resolve(base.dir).toLowerCase() ? base : dsh.profileTarget(dir, base);
        return { from, to: { ...from, file: target.config, format: "dsh-patch" } };
      });
  }
  fingerprint(ids, enabled) {
    return hash(
      JSON.stringify(
        ids
          .filter((id) => this.isDirect(id))
          .map((id) => [
            this.fields.fingerprint(id),
            id === "dsh" ? this.dshRelocations().map(({ from, to }) => [to.file, read(to.file), read(from.file + ".imported")]) : null,
            enabled
              ? this.desired(id).fields.map((e) => [e, read(e.file)])
              : null,
          ]),
      ),
    );
  }
  status(id, enabled = false) {
    const files = this.list([id]);
    if (!this.isDirect(id)) return {};
    let modelCount = 0;
    let error = this.fields.error || this.errors[id] || "",
      pending = !!this.fields.state.pending;
    if (!pending && !error) {
      try {
        if (enabled && id === "dsh" && this.dshRelocations().length)
          throw Error("DSH 当前版本读取 profile 补丁，旧接入尚未迁移；请点击一键修复");
        const plan = this.desired(id);
        modelCount = plan.modelCount;
        if (enabled) {
          if (!modelCount && !plan.nativeModelCount && !this.activated.has(id) && !this.manager.options.isConnected?.(id)) error = "没有可接入的模型";
          pending = this.fields.plan(id, plan.fields).files.length > 0;
        }
      } catch (e) {
        error = e.message;
      }
    }
    return { mode: "native", files, error, pending, modelCount,
      applied: enabled && !pending && !error,
      // DSH watches its native config and updates the Host registry live, but its
      // browser model catalog is cached for the current Host generation. The
      // backend therefore needs no restart; an already-open page must reload.
      runtimeStatus: enabled
        ? id === "dsh" ? "client-refresh-required" : "reload-required"
        : "inactive" };
  }
}
module.exports = {
  NativeConfig,
  compose,
  locations,
  providerId,
  DIRECT,
  piLiteral,
  baseUrl,
  profileLocations,
};
