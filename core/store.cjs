const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { atomic } = require("./config.cjs");
const { validateProviders } = require('./config-limits.cjs');
const { apiIdentity } = require('./native-api-identity.cjs');
const { OUTPUT_DEFAULTS_VERSION, upgradeModelOutput } = require('./output-tokens.cjs');
const {
  parseImport,
  normalizeProvider,
  normalizeModel,
  officialModel,
  makeCatalog,
} = require("./models.cjs");
class Store {
  constructor(dataDir, codexDir, crypto) {
    this.dataDir = dataDir;
    this.codexDir = codexDir;
    this.crypto = crypto;
    this.file = path.join(dataDir, "settings.json");
    this.state = { providers: [], officialOverrides: {}, autoStart: false, outputTokenDefaultsVersion: OUTPUT_DEFAULTS_VERSION };
    this.officialModels = [];
    this.readCatalog();
    this.persisted = null;
    this.reload();
    this.writeCatalog();
  }
  reload() {
    const text = fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8") : null;
    if (text === this.persisted) return false;
    if (text === null) throw Error("供应商配置被外部移除，未用旧内存覆盖");
    const persisted = JSON.parse(text);
    if (!Array.isArray(persisted.providers)) throw Error("供应商配置无法识别，未覆盖");
    const state = { ...this.state, ...persisted, providers: persisted.providers.map(p => ({
      ...p, ...JSON.parse(this.crypto.decryptString(Buffer.from(p.secrets, "base64"))), secrets: undefined,
    })) };
    const previous = this.state, previousText = this.persisted;
    const migrate = persisted.outputTokenDefaultsVersion !== OUTPUT_DEFAULTS_VERSION;
    if (migrate) {
      state.providers = state.providers.map(p => ({ ...p, models: (p.models || []).map(upgradeModelOutput) }));
      state.officialOverrides = Object.fromEntries(Object.entries(state.officialOverrides || {}).map(([id, model]) => [id, upgradeModelOutput(model)]));
      state.outputTokenDefaultsVersion = OUTPUT_DEFAULTS_VERSION;
    }
    this.state = state;
    this.persisted = text;
    if (migrate) try { this.save(); }
    catch (error) { this.state = previous; this.persisted = previousText; throw error; }
    return true;
  }
  readCatalog() {
    const file = path.join(this.codexDir, 'models_cache.json');
    try {
      const stat = fs.statSync(file), stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      if (stamp === this.catalogStamp) return;
      if (stat.size > 8 * 1024 * 1024) throw Error('catalog size');
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      const models = c.models.filter(
        (m) => m.slug && !m.slug.includes("::"),
      );
      if (!models.length) throw Error('empty native catalog');
      // HarnessManager shares this array. Keep its official defaults current
      // when Codex replaces its cache during an app update.
      this.officialModels.splice(0, this.officialModels.length, ...models);
      this.catalogStamp = stamp;
    } catch {
      if (!this.officialModels.length) this.officialModels.push(
        {
          slug: "gpt-6-astra",
          display_name: "GPT-6-Astra",
          context_window: 272000,
        },
      );
    }
  }
  save() {
    validateProviders(this.state.providers);
    if ((fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8") : null) !== this.persisted)
      throw Error("供应商配置已在外部更新，请刷新后重试；未覆盖现有文件");
    if (!this.crypto.isEncryptionAvailable())
      throw new Error("Windows 凭据加密不可用，未保存");
    const providers = this.state.providers.map(
      ({ apiKey, extraHeaders, ...p }) => ({
        ...p,
        secrets: this.crypto
          .encryptString(JSON.stringify({ apiKey, extraHeaders }))
          .toString("base64"),
      }),
    );
    const catalog = path.join(this.dataDir, "catalog-draft.json");
    const previous = fs.existsSync(catalog) ? fs.readFileSync(catalog) : null;
    try {
      this.writeCatalog();
      // Settings are authoritative on restart; commit them only after the derived catalog.
      const text = JSON.stringify({ ...this.state, providers }, null, 2);
      if (this.persisted !== null)
        atomic(path.join(this.dataDir, 'backups', 'settings.previous.json'), this.persisted);
      atomic(this.file, text);
      this.persisted = text;
    } catch (error) {
      if (previous) atomic(catalog, previous);
      throw error;
    }
  }
  writeCatalog() {
    atomic(
      path.join(this.dataDir, "catalog-draft.json"),
      JSON.stringify(
        makeCatalog(
          this.officialModels,
          this.state.providers,
          this.state.officialOverrides,
        ),
        null,
        2,
      ),
    );
  }
  public() {
    this.readCatalog();
    return {
      ...this.state,
      providers: this.state.providers.map(({ apiKey, extraHeaders, ...p }) => ({
        ...p,
        hasKey: !!apiKey,
        headerCount: Object.keys(extraHeaders || {}).length,
      })),
      officialModels: this.officialModels
        .filter((m) => !this.state.officialOverrides[m.slug]?.removed)
        .map((m) => ({
          ...officialModel(m, this.state.officialOverrides[m.slug], this.officialModels),
          official: true,
          sourceModel: m.slug,
        })),
    };
  }
  import(raw) {
    const incoming = parseImport(raw, this.officialModels);
    const merged = [...this.state.providers];
    for (const p of incoming) {
      const index = merged.findIndex((x) => x.id === p.id);
      if (index < 0) merged.push(p);
      else {
        if (!p.apiKey) {
          if (
            new URL(p.baseUrl).origin !== new URL(merged[index].baseUrl).origin
          )
            throw new Error(
              "导入文件更改了已有供应商域名但未提供新 Key，已拒绝复用旧凭据",
            );
          p.apiKey = merged[index].apiKey;
        }
        merged[index] = p;
      }
    }
    const previous = this.state.providers;
    this.state.providers = merged;
    try {
      this.save();
    } catch (error) {
      this.state.providers = previous;
      throw error;
    }
    return {
      providers: incoming.length,
      models: incoming.reduce((a, p) => a + p.models.length, 0),
    };
  }
  updateProvider(input) {
    const existing = this.state.providers.find((p) => p.id === input.id);
    if (
      existing &&
      new URL(existing.baseUrl).origin !==
        new URL(input.baseUrl || existing.baseUrl).origin &&
      !input.apiKey
    )
      throw new Error(
        "更改供应商域名后请重新填写 API Key，避免旧密钥发送到新站点",
      );
    const provider = normalizeProvider(
      {
        ...existing,
        ...input,
        apiKey: input.apiKey || existing?.apiKey || "",
        extraHeaders: input.extraHeaders ?? existing?.extraHeaders ?? {},
      },
      this.officialModels,
    );
    const previous = this.state.providers;
    const index = previous.findIndex((p) => p.id === provider.id);
    this.state.providers =
      index < 0
        ? [...previous, provider]
        : previous.map((p, i) => (i === index ? provider : p));
    try {
      this.save();
    } catch (error) {
      this.state.providers = previous;
      throw error;
    }
    return provider.id;
  }
  removeProvider(id) {
    const provider = this.state.providers.find(p => p.id === id);
    if (!provider) return false;
    const previous = this.state, identity = apiIdentity(provider);
    this.state = { ...previous, providers: previous.providers.filter(p => p.id !== id) };
    if (identity) this.state.nativeApiExclusions = [...new Set([...(previous.nativeApiExclusions || []), identity])];
    if (/^native_api_[a-f0-9]{20}$/.test(id)) this.state.nativeSupplierExclusions = [...new Set([...(previous.nativeSupplierExclusions || []), id])];
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    return true;
  }
  model(providerId, input, originalName, expected) {
    const previous = this.state;
    const current =
      providerId === "official"
        ? this.public().officialModels.find(
            (m) => m.model === (originalName || input.model),
          )
        : this.state.providers
            .find((p) => p.id === providerId)
            ?.models.find((m) => m.model === (originalName || input.model));
    if (expected && !isDeepStrictEqual(current, expected))
      throw new Error("模型配置已变化，请取消行内修改并重试");
    if (originalName && !current) throw new Error("原模型已移除，请刷新后重试");
    this.state = structuredClone(previous);
    try {
      if (providerId === "official") {
        const source =
          current?.sourceModel ||
          this.officialModels.find((m) => m.slug === input.model)?.slug;
        if (!source) throw new Error("官方模型来源不存在，请刷新本机目录");
        if (input.wireApi && input.wireApi !== "openai-responses")
          throw new Error(
            "官方订阅只支持 Responses 接口；其他协议请使用 API 供应商",
          );
        const model = normalizeModel(
          input,
          { id: "official", name: "OpenAI 官方" },
          this.officialModels,
        );
        if (
          this.public().officialModels.some(
            (m) => m.sourceModel !== source && m.model === model.model,
          )
        )
          throw new Error("模型 ID 重复");
        this.state.officialOverrides[source] = model;
      } else {
        const p = this.state.providers.find((p) => p.id === providerId);
        if (!p) throw new Error("供应商不存在");
        const model = normalizeModel(input, p, this.officialModels);
        const idx = p.models.findIndex(
          (m) => m.model === (originalName || model.model),
        );
        if (p.models.some((m, i) => m.model === model.model && i !== idx))
          throw new Error("模型名称重复");
        if (idx < 0) p.models.push(model);
        else p.models[idx] = model;
      }
      this.save();
    } catch (error) {
      this.state = previous;
      throw error;
    }
  }
  removeModel(providerId, name, expected) {
    const current =
      providerId === "official"
        ? this.public().officialModels.find((m) => m.model === name)
        : this.state.providers
            .find((p) => p.id === providerId)
            ?.models.find((m) => m.model === name);
    if (!current) throw new Error("模型不存在或已移除");
    if (expected && !isDeepStrictEqual(current, expected))
      throw new Error("模型配置已变化，请刷新后重试");
    const previous = this.state;
    this.state = structuredClone(previous);
    try {
      if (providerId === "official")
        this.state.officialOverrides[current.sourceModel] = {
          ...current,
          enabled: false,
          removed: true,
        };
      else {
        const p = this.state.providers.find((p) => p.id === providerId);
        p.models = p.models.filter((m) => m.model !== name);
      }
      this.save();
    } catch (error) {
      this.state = previous;
      throw error;
    }
  }
}
module.exports = { Store };
