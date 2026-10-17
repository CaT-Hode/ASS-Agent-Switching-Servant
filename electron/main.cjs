const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  session,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  clipboard,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { Router } = require("../core/router.cjs");
const { Store } = require("../core/store.cjs");
const { ConfigManager, atomic } = require("../core/config.cjs");
const { normalizeModel, codexModelId } = require("../core/models.cjs");
const { exportConfig } = require("../core/config-export.cjs");
const { BALANCE_PRESETS, queryBalance } = require("../core/balance.cjs");
const { PROVIDER_PRESETS } = require("../core/presets.cjs");
const { HarnessManager } = require("../core/harnesses.cjs");
const { ClaudeDesktopGateway } = require("../core/claude-desktop-gateway.cjs");
const { NativeConfig } = require("../core/native-config.cjs");
const { ProxyConfig } = require("../core/proxy-config.cjs");
const {
  modelKey,
  declaredCapabilities,
  probeCapabilities,
  inspectStream,
  discoverModels,
} = require("../core/model-inspection.cjs");
const { ModelDirectory } = require("../core/model-directory.cjs");
const {
  DiagnosticHistory,
  diagnosticFingerprint,
  failureMessage,
} = require("../core/diagnostic-history.cjs");
const {
  DiagnosticBatch,
  diagnosticTargets,
} = require("../core/diagnostic-batch.cjs");
const { diagnosticMetrics } = require("../core/diagnostic-metrics.cjs");
const {
  OFFICIAL_SERVICES,
  serviceForProvider,
} = require("../core/official-services.cjs");
const { NativeKeyStore } = require("../core/native-key-store.cjs");
const { OAuthHistory } = require("../core/oauth-history.cjs");
const { ConversationLibrary } = require("../core/conversations.cjs");
const { ProjectConversations } = require("../core/project-conversations.cjs");
const { switchClientAccount } = require("../core/client-account-switch.cjs");
const { NativeLogin } = require("../core/native-login.cjs");
const { OpenRouterAuth } = require("../core/openrouter-auth.cjs");
const { UpdateChecker } = require("../core/updates.cjs");
const { InjectionFiles } = require("../core/injection-files.cjs");
const { ClientProcesses } = require("../core/client-processes.cjs");
const { Connections } = require("../core/connections.cjs");
const { ClientRestart } = require("../core/client-restart.cjs");
const { CodexWorkspaceRelay } = require('../core/codex-workspace-relay.cjs');
const { launchCodexDesktop, openCodexDesktop } = require('../core/codex-desktop-launch.cjs');
let codexWorkspaceRelay;
const { Preferences } = require("../core/preferences.cjs");
const { UsageHistory } = require("../core/usage-history.cjs");
const accountTransactions = require("../core/account-transactions.cjs");
const { modelSources, nativeModels } = require("../core/model-inventory.cjs");
const { nativeOfficialProvider: resolveNativeOfficialProvider } = require("../core/native-official.cjs");
const { apiIdentity } = require("../core/native-api-identity.cjs");
const { withReadScope } = require("../core/read-scope.cjs");
const { SnapshotPublisher, ClientSnapshot } = require("../core/snapshot-publisher.cjs");
const clientSnapshot = new ClientSnapshot(() => harnesses.snapshot());
const { RuntimeHealth } = require('../core/runtime-health.cjs');
let runtimeHealth;
process.on('uncaughtExceptionMonitor', error => runtimeHealth?.record('uncaught', error));
app.on('render-process-gone', () => runtimeHealth?.record('renderer-gone'));
function nativeOfficialProvider(client, account) {
  return resolveNativeOfficialProvider(client, account, { home: harnesses.nativeHome, env: harnesses.nativeEnv });
}
const { promoteNativeApiProfile, promoteNativeSupplier, sameApi } = require("../core/native-suppliers.cjs");
const { resolveNativeDiagnostic, checkNativeConnection } = require("../core/native-model-diagnostics.cjs");
const {
  nativeSubscriptionProvider,
} = require("../core/subscription-usage.cjs");
const { AccountInfo, ACCOUNT_DOCS } = require("../core/account-info.cjs");
const { historyProvider: oauthInfoProvider } = require("../core/oauth-info.cjs");
const testMode = process.argv.includes("--qa");
const customData = process.env.ASS_TEST_DATA;
if (testMode && customData) app.setPath("userData", customData);
else if (process.env.ASS_DATA_DIR) app.setPath("userData", path.resolve(process.env.ASS_DATA_DIR));
else
  // Stable pre-rename data location: keep existing DPAPI credentials and settings.
  app.setPath(
    "userData",
    path.join(app.getPath("appData"), "AI Switch Servant"),
  );
// Resolve inherited MSIX virtualization before Chromium loads its encryption key
// or any ASS store is opened. All normal launches must use the same profile.
try {
  if (require('../core/windows-profile.cjs').ensureDesktopProfile({
    directory: app.getPath('userData'), explicit: !!process.env.ASS_DATA_DIR || !!(testMode && customData),
  })) app.exit(0);
} catch (error) {
  dialog.showErrorBox('ASS 数据目录', error.message);
  app.exit(1);
}
app.setName("ASS");
app.setAppUserModelId("local.ass.desktop");
const { ProtocolNegotiation } = require("../core/protocol-negotiation.cjs");
let protocols;
let window,
  tray,
  store,
  config,
  router,
  harnesses,
  nativeConfig,
  proxyConfig,
  claudeDesktop,
  nativeKeys,
  oauthHistory,
  conversations,
  projectConversations,
  nativeLogin,
  accountInfo,
  diagnosticHistory,
  openRouterAuth,
  updates,
  connections,
  restarter,
  processes,
  preferences,
  usageHistory,
  quitting = false;
let recent = [],
  balances = {};
let startupError = "";
let snapshotSequence = 0;
const capabilities = Object.create(null),
  capabilityJobs = Object.create(null);
const modelDirectory = new ModelDirectory({
  getProvider: (id) => store.state.providers.find((p) => p.id === id),
  fetchUpstream: upstream,
  onChange: push,
  readNative: readNativeModelMetadata,
  readOfficial: () => ({
    source: "Codex 本机目录声明（未实测）",
    time: new Date().toISOString(),
    models: store.officialModels.map((m) => ({
      model: m.slug,
      displayName: m.display_name,
      declared: declaredCapabilities(m),
    })),
  }),
});
const providerModels = modelDirectory.results;
const probeControllers = new Map();
const diagnosticControllers = new Map();
const diagnosticBatch = new DiagnosticBatch({
  targets: () => diagnosticTargets(store.public(), authReady()),
  run: diagnose,
  onChange: () => {
    diagnosticHistory?.recordBatch(diagnosticBatch.state);
    push();
  },
});
const iconPath = path.join(__dirname, "../public/ass-app-icon.png");
let systemSession, directSession, testFetch;
const servicePort =
  testMode && /^\d+$/.test(process.env.ASS_TEST_PORT || "")
    ? Number(process.env.ASS_TEST_PORT)
    : 25819;
async function upstream(url, init, network = "system") {
  if (testMode && testFetch) return testFetch(url, init, network);
  return (network === "direct" ? directSession : systemSession).fetch(url, {
    ...init,
    credentials: "omit",
    redirect: "error",
  });
}
function readAuth() {
  const auth = JSON.parse(
    fs
      .readFileSync(path.join(store.codexDir, "auth.json"), "utf8")
      .replace(/^\uFEFF/, ""),
  );
  if (!auth.tokens?.access_token)
    throw new Error("未找到 ChatGPT 登录，请先在 Codex 登录");
  return {
    authorization: "Bearer " + auth.tokens.access_token,
    "chatgpt-account-id": auth.tokens.account_id || "",
  };
}
function authReady() {
  try {
    return !!readAuth().authorization;
  } catch {
    return false;
  }
}
function nativeDiagnosticContext(id, name) {
  return resolveNativeDiagnostic(id, name, harnesses.snapshot(), {
    home: harnesses.nativeHome, env: harnesses.nativeEnv, directories: providerModels,
  });
}
function diagnosticContext(id, name) {
  if (id.startsWith("native-test:")) {
    try { return nativeDiagnosticContext(id, name); } catch { return null; }
  }
  if (id !== "official") {
    const provider = store.state.providers.find((p) => p.id === id);
    return { provider, model: provider?.models.find((m) => m.model === name) };
  }
  let auth;
  try {
    auth = readAuth();
  } catch {}
  return {
    provider: {
      id,
      baseUrl: "https://chatgpt.com/backend-api/codex",
      network: "system",
    },
    model: store.public().officialModels.find((m) => m.model === name),
    auth,
  };
}
function log(record) {
  recent.unshift(record);
  recent = recent.slice(0, 100);
  try {
    const p = path.join(store.dataDir, "requests.jsonl");
    if (fs.existsSync(p) && fs.statSync(p).size > 2 * 1024 * 1024)
      fs.renameSync(p, p + ".previous");
    fs.appendFileSync(p, JSON.stringify(record) + "\n");
  } catch {}
  push();
}
function accountProvider(id) {
  const configured = store.state.providers.find((p) => p.id === id);
  if (configured || !id.startsWith("native-info:") || !harnesses)
    return configured;
  const saved = /^native-info:(codex|claude|pi|kimi|zcode):oauth-record:([a-f0-9]{24})$/.exec(id);
  if (saved) return oauthInfoProvider(oauthHistory, harnesses, saved[1], saved[2]);
  for (const c of harnesses.snapshot({ accountsOnly: true }).clients)
    for (const a of (c.modelAccounts || c.accounts)) {
      if (id !== "native-info:" + c.id + ":" + a.id) continue;
      return nativeOfficialProvider(c, a) || nativeSubscriptionProvider(c, a);
    }
}
function informationClient(id) {
  const client = harnesses.snapshot({ accountsOnly: true }).clients.find((c) => c.id === id);
  if (client) oauthHistory?.decorate(client);
  return client;
}
function informationProvider(client, account) {
  if (!client || !account) return null;
  if (account.kind === "api") return accountProvider(account.providerId);
  return (account.oauthRecordId && oauthInfoProvider(oauthHistory, harnesses, client.id, account.oauthRecordId)) ||
    nativeOfficialProvider(client, account) || nativeSubscriptionProvider(client, account);
}
async function readNativeModelMetadata(id, signal) {
  const client = harnesses
    .snapshot()
    .clients.find((c) => "native-" + c.id === id);
  if (!client) throw Error("原生客户端不存在");
  if (client.id === 'dsh') return require('../core/dsh-model-catalog.cjs').readDshModelMetadata(client, {
    home: harnesses.nativeHome, env: harnesses.nativeEnv, signal,
  });
  const accounts = {},
    errors = [];
  for (const a of (client.modelAccounts || client.accounts).filter((a) => a.kind !== "api")) {
    const local = nativeModels(
      client,
      a,
      harnesses.nativeHome,
      harnesses.nativeEnv,
    );
    const provider = nativeOfficialProvider(client, a);
    let models = local;
    if (provider) {
      try {
        const report = await discoverModels(provider, upstream, signal);
        models = report.models.map((m) => {
          const cached = local.find((x) => x.model === m.model);
          return {
            ...cached,
            model: m.model,
            displayName: cached?.displayName || m.displayName,
            wireApi:
              cached?.wireApi ||
              (provider.nativeProvider === "deepseek" ? "openai-chat" : require("../core/presets.cjs").inferProtocol(provider, m.model)),
            contextWindow:
              m.declared.contextWindow || cached?.contextWindow || null,
            efforts: m.declared.efforts.length
              ? m.declared.efforts
              : cached?.efforts || [],
            nativeProvider: provider.nativeProvider,
            enabled: true,
            catalogSource: "官方 /models 目录（未实测）",
          };
        });
      } catch {
        if (signal.aborted) throw Error("目录读取已取消");
        errors.push("在线目录读取失败，保留本机目录");
      }
    }
    accounts[a.id] = { models };
    if (provider && nativeOfficialProvider(client, a)?.apiKey === provider.apiKey &&
        accountInfo.public(provider).remote && !accountInfo.public(provider).error)
      promoteNativeSupplier({ store, client, account: a, verified: true, models,
        home: harnesses.nativeHome, env: harnesses.nativeEnv });
  }
  return {
    accounts,
    models: Object.values(accounts).flatMap((a) => a.models),
    time: new Date().toISOString(),
    source: "原生账户模型目录（未实测）",
    error: [...new Set(errors)].join("；") || undefined,
  };
}
let supplierSync;
async function syncNativeSuppliers() {
  if (supplierSync) return supplierSync;
  supplierSync = (async () => {
    // The native scan may follow an external import/migration while ASS stays
    // open. Never promote from (or later save over) a stale provider snapshot.
    store.reload();
    if (!connections.busy && !router.clientActive('codex')) proxyConfig.refreshOfficialCatalog();
    const clients = harnesses.snapshot().clients;
    for (const client of clients) {
      for (const profile of harnesses.nativeApis(client.id)) {
        // Discovery is local, including zero-model APIs. Verification/quotas
        // remain separate and must not gate their appearance as a supplier.
        try { promoteNativeApiProfile({ store, profile }); } catch {}
      }
    }
    for (const client of clients) {
      // DSH's local picker does not depend on a remote API verification result.
      if (client.id === 'dsh') {
        try { await readModelMetadata('native-dsh', true); } catch {}
      }
      const accounts = (client.modelAccounts || client.accounts).filter((a) => nativeOfficialProvider(client, a));
      let verified = false;
      for (const account of accounts) {
        const provider = nativeOfficialProvider(client, account);
        try {
          await accountInfo.refresh(provider.id, { automatic: true });
          verified ||= accountInfo.public(provider).remote && !accountInfo.public(provider).error;
        } catch {}
      }
      if (verified && client.id !== 'dsh') {
        try { await readModelMetadata("native-" + client.id, true); } catch {}
      }
    }
    for (const provider of store.state.providers.filter((p) => p.apiKey && !p.models.length &&
      !p.nativeCatalogInitialized && ["deepseek", "opencode", "opencode-go"].includes(require("../core/client-policy.cjs").officialApiService(p)))) {
      try {
        await accountInfo.refresh(provider.id, { automatic: true });
        if (accountInfo.public(provider).remote && !accountInfo.public(provider).error)
          await fillVerifiedSupplier(provider);
      } catch {}
    }
    push();
  })().finally(() => { supplierSync = null; });
  return supplierSync;
}
async function fillVerifiedSupplier(provider) {
  if (provider.models.length || provider.nativeCatalogInitialized) return;
  const report = await discoverModels(provider, upstream, AbortSignal.timeout(15000));
  const current = store.state.providers.find((p) => p.id === provider.id);
  if (!current || current.apiKey !== provider.apiKey || current.baseUrl !== provider.baseUrl || current.models.length) return;
  const models = report.models.flatMap((m) => {
    try { return [normalizeModel({ model: m.model, displayName: m.displayName,
      ...(require("../core/client-policy.cjs").officialApiService(current) === "deepseek" ? { wireApi: "openai-chat" } : {}),
      ...(m.declared.contextWindow >= 4096 ? { contextWindow: m.declared.contextWindow } : {}) }, current, store.officialModels)]; }
    catch { return []; }
  });
  if (models.length) store.updateProvider({ ...current, models, nativeCatalogInitialized: true });
}
async function refreshAccountInfo(id, options) {
  // Quota refresh is independent of model discovery. A cached quota must not
  // trigger another full client scan and a forced /models request.
  return accountInfo.refresh(id, options);
}
function snapshot() {
  return withReadScope(buildSnapshot);
}
async function refreshClientState(clientId) {
  // Manual refresh is one complete state transition, not a partial repaint.
  await processes.refresh();
  await harnesses.refreshOAuth({ rediscover: true });
  oauthHistory.scan({ immediate: true });
  await syncNativeSuppliers();
  if (typeof clientId === "string") {
    const client = informationClient(clientId);
    if (!client) throw Error("未知客户端");
    const providers = new Map(client.accounts.map((account) => {
      const provider = informationProvider(client, account); return [provider?.id, provider];
    }).filter(([id]) => id));
    await Promise.allSettled([...providers.values()].filter((p) => accountInfo.public(p).canRefresh)
      .map((p) => refreshAccountInfo(p.id)));
  }
  return snapshot();
}
function buildSnapshot() {
  store.reload();
  const publicState = store.public(), clients = clientSnapshot.current(), clientState = clients.state;
  const nativeApiModels = [];
  for (const client of clientState.clients)
    for (const account of client.accounts) {
      const subscription = nativeSubscriptionProvider(client, account);
      if (subscription) account.quota = accountInfo.public(subscription);
      const provider =
        account.kind === "api"
          ? store.state.providers.find((p) => p.id === account.providerId)
          : nativeOfficialProvider(client, account);
      if (provider) {
        if (account.kind !== "api") {
          account.supplierId = store.state.providers.find((p) => p.apiKey === provider.apiKey &&
            p.baseUrl.replace(/\/$/, "") === provider.baseUrl.replace(/\/$/, ""))?.id;
        }
        const localProfile = account.profile;
        const remote = accountInfo.public(provider);
        const models =
          account.kind === "api"
            ? provider.models
            : providerModels["native-" + client.id]?.accounts?.[account.id]
                ?.models ||
              nativeModels(
                client,
                account,
                harnesses.nativeHome,
                harnesses.nativeEnv,
              );
        account.profile = {
          ...remote,
          credentialUpdatedAt:
            account.kind !== "api" ? localProfile?.updatedAt : undefined,
          fields: [
            ...remote.fields.map((field) =>
              field.id === "network" && nativeConfig.isDirect(client.id)
                ? { ...field, value: "原生客户端配置" }
                : field,
            ),
            {
              id: "models",
              label: account.kind === "api" ? "已配置模型" : "目录模型",
              value: String(models.length),
            },
          ],
        };
      }
    }
  for (const client of clientState.clients) {
    oauthHistory?.decorate(client);
    for (const account of client.accounts) {
      if (!account.oauthRecordId) continue;
      const provider = oauthInfoProvider(oauthHistory, harnesses, client.id, account.oauthRecordId);
      if (!provider) continue;
      const remote = accountInfo.public(provider);
      if (["kimi", "zcode"].includes(client.id)) {
        const local = account.profile || { fields: [], docs: [] };
        const ids = new Set(remote.fields.map((f) => f.id));
        account.profile = { ...local, ...remote, docs: [...new Set([...local.docs, ...remote.docs])],
          fields: [...local.fields.filter((f) => !ids.has(f.id)), ...remote.fields] };
      } else account.quota = remote;
    }
  }
  // History cards are account UI only: never turn inactive grants into a native
  // model source or read credentials from their former file location. Build the
  // source list after decorating the current account so a successful ZCode
  // entitlement query can constrain only that account's Start Plan catalog.
  for (const client of clientState.clients)
    for (const account of client.modelAccounts || client.accounts) {
      const native = nativeOfficialProvider(client, account);
      if (native) account.supplierId = store.state.providers.find((p) => sameApi(p, native))?.id;
    }
  for (const client of clientState.clients) for (const profile of harnesses.nativeApis(client.id)) {
    const supplier = store.state.providers.find((provider) => sameApi(provider, profile));
    if (!supplier && store.state.nativeApiExclusions?.includes(apiIdentity(profile))) {
      // Keep the native account card, but do not resurrect an excluded API as
      // an unassigned native model source (for example an unfunded Zen key).
      nativeApiModels.push(...profile.modelRefs.map(ref => ({ ...ref, excluded: true })));
      continue;
    }
    if (!supplier) continue;
    for (const ref of profile.accountRefs || [])
      for (const account of client.modelAccounts || client.accounts)
        if (ref.clientId === client.id && account.id === ref.accountId && !account.catalogOnly) account.supplierId = supplier.id;
    for (const ref of profile.modelRefs) {
      nativeApiModels.push({ ...ref, supplierId: supplier.id });
    }
  }
  const sources = modelSources(publicState, clientState, {
    home: harnesses.nativeHome, env: harnesses.nativeEnv, directories: providerModels, nativeApiModels,
    ownsModel: (client, account, model) => nativeConfig.ownsModel(client.id, account, model),
  });
  return {
    ...publicState,
    nativeScanError: clients.error,
    sequence: ++snapshotSequence,
    modelSources: sources,
    preferences: preferences.state,
    usage: usageHistory?.public(),
    harnesses: clientState,
    accountDocs: ACCOUNT_DOCS,
    providerInfo: Object.fromEntries(
      store.state.providers.map((p) => [p.id, accountInfo.public(p)]),
    ),
    connections: connections.snapshot(),
    claudeDesktop: (() => { try { return claudeDesktop.status(proxyConfig.clients.claude?.localToken, servicePort); }
      catch (error) { return { configured: false, owned: false, current: false, conflict: true, error: error.message }; } })(),
    providerPresets: PROVIDER_PRESETS,
    officialServices: OFFICIAL_SERVICES,
    officialProviderIds: Object.fromEntries(
      store.state.providers.map((p) => [p.id, serviceForProvider(p)?.id || ""]),
    ),
    nativeAccounts: nativeKeys.public(),
    openRouterAuth: openRouterAuth.state,
    updates: updates.snapshot(),
    balancePresets: BALANCE_PRESETS,
    service: {
      running: !!router.server,
      port: router.port,
      active: router.active,
    },
    codex: { ...config.status(), officialService: codexWorkspaceRelay?.status() },
    authReady: authReady(),
    encrypted: safeStorage.isEncryptionAvailable(),
    recent,
    diagnostics: diagnosticHistory.public(),
    diagnosticHistoryError: diagnosticHistory.error,
    diagnosticBatch: diagnosticBatch.snapshot(),
    diagnosticJobs: Object.fromEntries(
      [...diagnosticControllers.keys()].map((key) => [key, true]),
    ),
    providerModels,
    modelDirectoryJobs: modelDirectory.jobs(),
    modelDirectoryRevisions: modelDirectory.revisions,
    capabilities: { ...protocols?.public(), ...capabilities },
    protocolResults: protocols?.public(),
    protocolJobs: protocols?.progress(),
    protocolError: protocols?.error,
    capabilityJobs,
    balances,
    startupError,
    version: app.getVersion(),
    dataDir: store.dataDir,
  };
}
const publisher = new SnapshotPublisher({ read: snapshot,
  canSend: () => !!window && !window.isDestroyed() && window.isVisible() && !window.isMinimized(),
  send: (value) => window.webContents.send("ass:state", value),
  onError: (error) => {
    runtimeHealth?.record('snapshot', error);
    if (window && !window.isDestroyed()) window.webContents.send("ass:state-error",
      "客户端状态读取失败，保留当前画面；请刷新重试。");
  } });
function push() { publisher.push(); }
function register(name, handler) {
  ipcMain.handle("ass:" + name, async (event, ...args) => {
    const url = event.senderFrame?.url || "";
    if (
      !window ||
      event.sender !== window.webContents ||
      !url.startsWith("file://")
    )
      throw new Error("Invalid caller");
    let result;
    try {
      result = await handler(...args);
      // Saving an account/catalog preference never rewrites a running client's
      // configuration. Connection preview/apply is the explicit commit point.
      return result;
    } finally {
      if ((name === "snapshot" || name === "client-refresh") && result?.sequence) publisher.publish(result);
      else if (result?.snapshot?.sequence) publisher.publish(result.snapshot);
      else push();
    }
  });
}
async function diagnose(providerId, modelName, signal) {
  if (connections.busy) throw new Error("正在切换接入，请稍后检查模型");
  const start = Date.now();
  const official = providerId === "official";
  const native = providerId.startsWith("native-test:") ? nativeDiagnosticContext(providerId, modelName) : null;
  const p = native?.provider || store.state.providers.find((p) => p.id === providerId);
  const selected = native?.model || (
    official ? store.public().officialModels : p?.models || []
  ).find((m) => m.model === modelName && m.enabled !== false);
  if (!selected || (!official && !p.enabled))
    throw new Error("请选择具体的已启用模型进行检测");
  const name = selected.model,
    key = modelKey(providerId, name);
  let metrics = diagnosticMetrics(native?.request.protocol || selected.wireApi || "openai-responses", native ? "native" : "router");
  if (diagnosticControllers.has(key)) throw Error("此模型正在检测");
  const fingerprint = native ? diagnosticFingerprint(native) : diagnosticHistory.fingerprint(providerId, name);
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([
    controller.signal,
    ...(signal ? [signal] : []),
    AbortSignal.timeout(90000),
  ]);
  diagnosticControllers.set(key, controller);
  let result;
  const model = official ? name : codexModelId(providerId, name);
  const body = {
    model,
    instructions: "Reply concisely.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Reply exactly OK." }],
      },
    ],
    stream: true,
    store: false,
    reasoning: {
      effort: official
        ? "low"
        : selected.defaultEffort || "medium",
    },
  };
  try {
    requestSignal.throwIfAborted();
    if (!official && !native) {
      await protocols.ensure(p, selected, { force: true, signal: requestSignal });
      metrics = diagnosticMetrics(protocols.select(p, selected, "codex"), "router");
    }
    if (native) {
      const checked = await checkNativeConnection(native, upstream, requestSignal, metrics);
      result = { providerId, model: name, ok: true, ms: Date.now() - start,
        time: new Date().toISOString(), ...checked };
    } else {
    if (!router.server) await router.start(servicePort);
    const headers = official
      ? readAuth()
      : { authorization: "Bearer ass-local-diagnostic" };
    const r = await fetch(
      `http://127.0.0.1:${router.port}/diagnostics/v1/responses`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "x-ass-probe-token": router.clientToken,
          "session_id": "ass-diagnostic-" + require("node:crypto").randomUUID(),
          "user-agent": "ASS/model-diagnostics",
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      },
    );
    metrics.headers(r);
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error(
        "HTTP " + r.status + "；请检查该模型的凭据、协议和网络出口",
      );
    }
    const inspected = await inspectStream(r.body, "openai-responses", undefined, metrics.observe);
    if (!inspected.completed || !inspected.text)
      throw new Error("未收到完整结束事件");
    result = {
      providerId,
      ok: true,
      ms: Date.now() - start,
      time: new Date().toISOString(),
      model: name,
      message: "连接成功 · 完整流式响应",
    };
    }
  } catch (error) {
    result = {
      providerId,
      ok: false,
      ms: Date.now() - start,
      time: new Date().toISOString(),
      model: name,
      message:
        signal?.aborted || controller.signal.aborted
          ? "已取消"
          : error.name === "TimeoutError"
            ? "请求超时（90 秒）"
            : failureMessage(error.message),
      cancelled: !!signal?.aborted || controller.signal.aborted,
    };
  } finally {
    diagnosticControllers.delete(key);
  }
  Object.assign(result, metrics.finish(result.ok));
  if (result.ok && !signal?.aborted && !controller.signal.aborted && native?.client && native?.account) {
    const current = nativeOfficialProvider(native.client, native.account);
    if (current?.apiKey === native.provider.apiKey &&
        new URL(native.request.url).origin === new URL(current.baseUrl).origin)
      try {
        promoteNativeSupplier({ store, client: native.client, account: native.account, verified: true,
          models: providerModels["native-" + native.client.id]?.accounts?.[native.account.id]?.models,
          home: harnesses.nativeHome, env: harnesses.nativeEnv });
      } catch { result.supplierSaveFailed = true; }
  }
  if (signal?.aborted || controller.signal.aborted) result.cancelled = true;
  if (!result.cancelled && !diagnosticHistory.record(result, fingerprint)) {
    result.cancelled = true;
    result.message = "模型或账户配置已变化，请重新测试";
  }
  push();
  return result;
}
function invalidateReports(id, metadata = true) {
  diagnosticBatch.cancel();
  for (const [key, controller] of diagnosticControllers)
    if (!id || JSON.parse(key)[0] === id) controller.abort();
  diagnosticHistory.reconcile();
  for (const results of [capabilities])
    for (const key of Object.keys(results))
      if (!id || JSON.parse(key)[0] === id) delete results[key];
  if (metadata) modelDirectory.invalidate(id);
  for (const key of Object.keys(balances))
    if (!id || key === id) delete balances[key];
  for (const [key, controller] of probeControllers)
    if (!id || JSON.parse(key)[0] === id) controller.abort();
}
async function prepareProtocols(scope) {
  const ids = connections.ids(scope);
  const selected = new Set(ids.flatMap(id => harnesses.injection(id).models.filter(m => m.included).map(m => modelKey(m.providerId, m.model))));
  await protocols.ensureProviders(store.state.providers.map(p => ({ ...p,
    models: p.models.filter(m => selected.has(modelKey(p.id, m.model))) })));
}
let protocolQueue = Promise.resolve();
function queueProtocolChecks(id, name) {
  protocolQueue = protocolQueue.then(() => protocols.ensureProviders(store.state.providers
    .filter(p => !id || p.id === id).map(p => ({ ...p, models: p.models.filter(m => !name || m.model === name) }))))
    .catch(() => { /* Preserve configuration; explicit injection/test reports failures. */ });
}
function readModelMetadata(id, refresh = false) {
  return modelDirectory.read(id, { refresh: refresh === true });
}
async function probeModel(id, name) {
  if (diagnosticBatch.state.running || diagnosticControllers.size)
    throw Error("连接测试正在进行，请等待或先取消");
  const provider = store.state.providers.find((p) => p.id === id && p.enabled);
  const model = provider?.models.find((m) => m.model === name && m.enabled);
  if (!model || !provider.apiKey) throw Error("请先配置并启用该供应商和模型");
  if (probeControllers.size)
    throw Error("已有能力检测正在运行，请等待或先取消");
  const key = modelKey(id, name),
    controller = new AbortController();
  probeControllers.set(key, controller);
  const timer = setTimeout(() => controller.abort(), 240000);
  try {
    capabilityJobs[key] = "读取模型元数据";
    push();
    await readModelMetadata(id);
    const report = await probeCapabilities(provider, model, upstream, {
      signal: controller.signal,
      progress: (message) => {
        capabilityJobs[key] = message;
        push();
      },
    });
    if (!controller.signal.aborted) {
      capabilities[key] = report;
      protocols.record(provider, model, report);
    }
    return report;
  } finally {
    clearTimeout(timer);
    delete capabilityJobs[key];
    probeControllers.delete(key);
    push();
  }
}
const balanceAttempts = new Map(),
  balanceJobs = new Map();
async function balance(id, automatic = false) {
  const p = store.state.providers.find((p) => p.id === id);
  if (!p) throw new Error("供应商不存在");
  const key = JSON.stringify([
    p.id,
    p.baseUrl,
    p.apiKey,
    p.extraHeaders,
    p.balance,
    p.network,
  ]);
  if (balanceJobs.has(key)) return balanceJobs.get(key);
  if (automatic && Date.now() - (balanceAttempts.get(key) || 0) < 5 * 60000)
    return balances[id];
  balanceAttempts.set(key, Date.now());
  const job = queryBalance(p, upstream);
  balanceJobs.set(key, job);
  try {
    const result = await job;
    const current = store.state.providers.find((p) => p.id === id);
    if (
      !current ||
      JSON.stringify([
        current.id,
        current.baseUrl,
        current.apiKey,
        current.extraHeaders,
        current.balance,
        current.network,
      ]) !== key
    )
      return null;
    balances[id] = result;
  } catch (error) {
    const current = store.state.providers.find((p) => p.id === id);
    if (
      !current ||
      JSON.stringify([
        current.id,
        current.baseUrl,
        current.apiKey,
        current.extraHeaders,
        current.balance,
        current.network,
      ]) !== key
    )
      return null;
    balances[id] = {
      ...(balances[id] || {}),
      ok: !!balances[id]?.ok,
      error: "余额查询失败，请检查接口与 Key 权限",
      message: "余额查询失败，请检查接口与 Key 权限",
      checkedAt: new Date().toISOString(),
    };
  } finally {
    balanceJobs.delete(key);
  }
  push();
  return balances[id];
}
function windowChrome() {
  return { color: nativeTheme.shouldUseDarkColors ? "#1a1a1a" : "#f3f3f3",
    symbolColor: nativeTheme.shouldUseDarkColors ? "#e4e8e5" : "#272928", height: 44 };
}
function syncWindowTheme() {
  if (!window || window.isDestroyed()) return;
  window.setBackgroundColor(windowChrome().color);
}
async function codexWorkspaceLaunchOptions() {
  if (!connections.enabled.codex || proxyConfig.clients.codex?.accountless)
    return null;
  proxyConfig.requireCodexOfficialService();
  const configured = require('@iarna/toml').parse(fs.readFileSync(config.file, 'utf8')).chatgpt_base_url;
  if (configured && configured !== 'https://chatgpt.com/backend-api/')
    throw Error('检测到自定义官方后端地址，未改用 ASS 官方服务中转');
  for (const name of ['CODEX_API_BASE_URL','CODEX_APP_SERVER_CHATGPT_BASE_URL'])
    if (process.env[name] && process.env[name] !== 'https://chatgpt.com/backend-api/')
      throw Error('存在官方服务环境覆盖，未改用 ASS 中转');
  return codexWorkspaceRelay.start();
}
let windowStateSequence = 0;
function publishWindowState() {
  if (!window || window.isDestroyed()) return;
  const state = { ...require('../core/window-controls.cjs').windowState(window), sequence: ++windowStateSequence };
  window.webContents.send('ass:window-state', state);
  return state;
}
nativeTheme.on("updated", syncWindowTheme);
function showWindow() {
  if (window) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1380,
    height: 930,
    minWidth: 1100,
    minHeight: 740,
    title: "ASS · 模型随你切",
    icon: iconPath,
    backgroundColor: windowChrome().color,
    autoHideMenuBar: true,
    ...(process.platform === "win32" ? { titleBarStyle: "hidden", titleBarOverlay: false } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  if (process.platform === "win32") {
    // Keep taskbar identity explicit when a versioned installation is replaced.
    window.setAppDetails({
      appId: "local.ass.desktop",
      appIconPath: app.isPackaged ? process.execPath : path.join(__dirname, "../assets/ass.ico"),
      appIconIndex: 0,
      relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`,
      relaunchDisplayName: "ASS",
    });
  }
  window.loadFile(path.join(__dirname, "../dist/index.html"));
  window.on("show", push);
  window.on("restore", push);
  for (const event of ['maximize', 'unmaximize', 'minimize', 'restore', 'focus', 'blur', 'show', 'hide'])
    window.on(event, publishWindowState);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    window = null;
  });
}
function exitStatus() {
  const status = connections.exitStatus();
  try {
    if (claudeDesktop.owner()) {
      status.safeNeeded = true;
      status.names.push("Claude 桌面版");
      claudeDesktop.preflightDisable();
    }
  } catch (error) {
    status.safeNeeded = true;
    status.error = error.message;
  }
  status.canDirectExit = !status.safeNeeded && !status.error && status.active === 0 && !connections.busy;
  return status;
}
function finishDirectExit() {
  quitting = true;
  setImmediate(() => app.quit());
}
function requestExit() {
  if (quitting) return;
  try {
    if (exitStatus().canDirectExit) {
      connections.directExit(true, finishDirectExit);
      return;
    }
  } catch { /* The confirmation flow will display the inspection error. */ }
  showWindow();
  const request = () =>
    window?.webContents.send("ass:manage", {
      scope: "all",
      enabled: false,
      quit: true,
    });
  if (window.webContents.isLoading())
    window.webContents.once("did-finish-load", request);
  else request();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showWindow);
  app
    .whenReady()
    .then(async () => {
      const dataDir = app.getPath("userData");
      const codexDir = testMode
        ? process.env.ASS_TEST_CODEX ||
          path.join(dataDir, "test-home", ".codex")
        : path.resolve(
            (
              process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
            ).replace(/^~(?=[/\\]|$)/, os.homedir()),
          );
      fs.mkdirSync(dataDir, { recursive: true });
      runtimeHealth = new RuntimeHealth(dataDir, safeStorage, app.getVersion());
      systemSession = session.fromPartition("ass-system");
      directSession = session.fromPartition("ass-direct");
      await systemSession.setProxy({ mode: "system" });
      await directSession.setProxy({ mode: "direct" });
      store = new Store(dataDir, codexDir, safeStorage);
      protocols = new ProtocolNegotiation({ dataDir, crypto: safeStorage,
        getProviders: () => store.state.providers, fetcher: upstream, onChange: () => { if (connections) push(); } });
      diagnosticHistory = new DiagnosticHistory({
        dataDir,
        crypto: safeStorage,
        getContext: diagnosticContext,
      });
      diagnosticBatch.restore(diagnosticHistory.batch);
      preferences = new Preferences(dataDir);
      nativeTheme.themeSource = preferences.state.theme;
      updates = new UpdateChecker({
        dataDir,
        currentVersion: app.getVersion(),
        fetchRelease: (url, init) => upstream(url, init, "system"),
        onChange: push,
      });
      nativeKeys = new NativeKeyStore(dataDir, safeStorage);
      accountInfo = new AccountInfo({
        dataDir,
        crypto: safeStorage,
        getProvider: accountProvider,
        fetcher: upstream,
      });
      openRouterAuth = new OpenRouterAuth({
        fetchUpstream: upstream,
        openExternal: (url) => shell.openExternal(url),
        onChange: push,
        saveKey: (apiKey, name, client) => {
          const input = {
            ...OFFICIAL_SERVICES.find((s) => s.id === "openrouter").profiles[0],
            id: undefined,
            name,
            apiKey,
            models: [],
            enabled: true,
            balance: { preset: "auto" },
          };
          return client
            ? accountTransactions.saveBoundApi(store, harnesses, client, input)
            : store.updateProvider(input);
        },
      });
      config = new ConfigManager(codexDir, dataDir, servicePort);
      const injections = new InjectionFiles(dataDir);
      processes = new ClientProcesses({ dataDir });
      harnesses = new HarnessManager(
        dataDir,
        () => store.state,
        store.officialModels,
        codexDir,
        {
          port: servicePort,
          injections,
          processes,
          protocols,
          isConnected: (id) => connections.allow(id),
          ...(testMode
            ? { home: path.join(dataDir, "test-home"), env: {} }
            : {}),
        },
      );
      await harnesses.refreshOAuth();
      usageHistory = new UsageHistory({
        dataDir,
        crypto: safeStorage,
        onChange: push,
        getOptions: () => ({
          dataDir,
          home: harnesses.nativeHome,
          env: harnesses.nativeEnv,
          codexDir,
          overrides: harnesses.state.credentialHomes,
          profiles: harnesses.state.profiles.map(({ id, harness }) => ({
            id,
            harness,
          })),
        }),
      });
      nativeConfig = new NativeConfig(dataDir, safeStorage, harnesses);
      harnesses.options.nativeConfig = nativeConfig;
      claudeDesktop = new ClaudeDesktopGateway(dataDir, testMode
        ? { directory: path.join(dataDir, "claude-desktop"), policyReader: () => ({}) } : {});
      proxyConfig = new ProxyConfig(dataDir, safeStorage, harnesses, store, config, claudeDesktop);
      if (proxyConfig.recoveryError) runtimeHealth.record('codex-recovery', Error(proxyConfig.recoveryError));
      harnesses.options.proxyConfig = proxyConfig;
      const codexOfficialAuth = new (require('../core/codex-official-auth.cjs').CodexOfficialAuth)(codexDir);
      router = new Router({
        getState: (id) => proxyConfig.routingState(id),
        fetchUpstream: upstream,
        log,
        allowClient: (id) => connections.allow(id),
        onActivity: push,
        getOfficialAuth: options => codexOfficialAuth.headers(options),
      });
      codexWorkspaceRelay = new CodexWorkspaceRelay({ dataDir, crypto: safeStorage, router });
      restarter = new ClientRestart({
        desktop: (id) => harnesses.desktop(id),
        processes,
        launchDesktop: async (apps, adapter) => {
          for (const target of apps) {
            const options = target.id === 'codex' ? await codexWorkspaceLaunchOptions() : null;
            const result = options ? await launchCodexDesktop(target.exe, options) : await adapter.launch([target]);
            if (result?.launched !== true) throw Error('客户端启动失败');
          }
          return { launched: true };
        },
        // Never discover or terminate real desktop processes from an isolated QA.
        ...(testMode ? { adapter: { inventory: async () => ({ apps: [], rows: [] }) } } : {}),
      });
      connections = new Connections({
        dataDir,
        router,
        config,
        injections,
        nativeConfig,
        proxyConfig,
        processes,
        port: servicePort,
        onChange: push,
        extraActive: () => probeControllers.size,
        restarter,
        sessionHandoff: new (require('../core/codex-session-handoff.cjs').CodexSessionHandoff)({
          codexDir, dataDir, crypto: safeStorage, config, officialModels: () => store.officialModels,
          assertIdle: testMode ? async () => {} : async () => {
            try { await require('../core/conversation-delete-guard.cjs').assertDeletionIdle([{ harness: 'codex' }]); }
            catch (error) { throw Error('请先关闭 Codex，或选择强制关闭 / 重启，再恢复官方续聊。', { cause: error }); }
          },
        }),
      });
      oauthHistory = new OAuthHistory({
        dataDir, crypto: safeStorage,
        sources: () => harnesses.oauthHistorySources(),
        target: (id, provider) => harnesses.oauthHistoryTarget(id, provider),
        allows: (id, provider) => harnesses.oauthHistoryAllows(id, provider),
        // Kept only for recovery of a transaction created by an older ASS;
        // retired clients are not scanned, exposed, or writable through IPC.
        external: { "antigravity-keyring": require("../core/antigravity-status.cjs").keyringAdapter },
        onChange: push,
        refresh: async () => {
          if (!connections.busy && !router.clientActive('codex')) proxyConfig.refreshOfficialCatalog();
        },
      });
      conversations = new ConversationLibrary({ dataDir, crypto: safeStorage,
        sources: () => harnesses.conversationSources() });
      projectConversations = new ProjectConversations({ dataDir, crypto: safeStorage,
        assertDeletionIdle: testMode ? undefined : require('../core/conversation-delete-guard.cjs').assertDeletionIdle,
        sources: () => harnesses.conversationSources(), history: async () => {
          await conversations.refresh(true);
          return conversations.entries.filter((r) => r.nativePresent || r.snapshot).map((r) => conversations.publicRow(r));
        }, assertIdle: async (id) => {
          await processes.refresh();
          if (processes.sessions.some((r) => r.account === 'project:' + id && r.status !== 'gone'))
            throw Error('请先关闭此项目由 ASS 启动的续聊窗口，再关闭同步');
        }, releaseImports: async (plan) => {
          const codecs = require('../core/project-codecs.cjs');
          for (const item of [...plan.returns, ...plan.imports]) {
            const launcher = harnesses.launcher('opencode'); if (!launcher.ready) throw Error('请配置 OpenCode CLI 后再关闭此项目同步');
            const current = harnesses.projectConversationPlan('opencode', item.cwd);
            if (codecs.pathKey(current.dir) !== codecs.pathKey(item.dir)) throw Error('OpenCode 数据目录已变化，未删除旧目录的记录');
            if (item.signature && codecs.hash(JSON.stringify(codecs.openCodeBundle(path.join(item.dir, 'opencode.db'), item.sessionId))) !== item.signature)
              throw Error('OpenCode 会话已改变，请重新关闭同步');
            if (!item.signature) {
              const expected = JSON.parse(fs.readFileSync(item.file, 'utf8'));
              try { const existing = codecs.openCodeBundle(path.join(item.dir, 'opencode.db'), item.sessionId);
                if (!require('../core/opencode-version.cjs').equal(existing, expected)) throw Error('OpenCode 已有同 ID 的其他内容，未覆盖');
              } catch (error) { if (!/会话不存在|unable to open database file/.test(error.message)) throw error; }
            }
            await new Promise((resolve, reject) => require('node:child_process').execFile(launcher.executable,
              [...launcher.args, ...require('../core/opencode-version.cjs').command(require('../core/opencode-version.cjs').version(launcher, item.dir), item.signature ? 'delete' : 'import', item.signature ? item.sessionId : item.file)],
              { cwd: item.cwd, env: current.env, windowsHide: true, timeout: 30000, maxBuffer: 1024 ** 2 },
              (error) => error ? reject(Error('OpenCode 归回或清理失败，原会话与 ASS 备份保留；请重试')) : resolve()));
            if (item.signature) {
              let removed = false;
              try { codecs.openCodeBundle(path.join(item.dir, 'opencode.db'), item.sessionId); }
              catch (error) { if (/会话不存在/.test(error.message)) removed = true; else throw error; }
              if (!removed) throw Error('OpenCode 未移除同步副本，未关闭同步；请重试');
            } else {
              const expected = JSON.parse(fs.readFileSync(item.file, 'utf8'));
              const returned = codecs.openCodeBundle(path.join(item.dir, 'opencode.db'), item.sessionId);
              if (!require('../core/opencode-version.cjs').equal(returned, expected)) throw Error('OpenCode 归回内容不一致，未关闭同步');
              if (codecs.pathKey(require('../core/opencode-version.cjs').cwd(returned)) !== codecs.pathKey(item.cwd)) throw Error('OpenCode 归回位置不一致，未关闭同步');
            }
          }
        } });
      projectConversations.start();
      nativeLogin = new NativeLogin({ harnesses, history: oauthHistory, processes });
      try {
        if (connections.routerEnabled()) await router.start(servicePort);
      } catch (error) {
        startupError = "端口 " + servicePort + " 无法启动：" + error.message;
      }
      if (connections.enabled.codex && proxyConfig.clients.codex?.gatewayAuth && !proxyConfig.clients.codex.accountless) {
        try { await codexWorkspaceLaunchOptions(); }
        catch (error) { startupError = [startupError,'Codex 官方服务中转未恢复：'+error.message].filter(Boolean).join('；'); }
      }
      register("snapshot", () => snapshot());
      register("window-action", (action) => {
        require('../core/window-controls.cjs').windowAction(window, action);
        return publishWindowState();
      });
      register("ui-preferences", (input) => {
        const result = preferences.update(input);
        nativeTheme.themeSource = result.theme;
        syncWindowTheme();
        return result;
      });
      register("usage-refresh", (automatic) =>
        usageHistory.refresh({ automatic: automatic === true }),
      );
      register(
        "supplier-refresh",
        async (sourceId, accountId, automatic = false) => {
          if (sourceId === "official" || (!store.state.providers.some(p => p.id === sourceId) && /^native-(codex|claude|dsh|opencode|pi|kimi|zcode)$/.test(sourceId))) {
            const clientId =
              sourceId === "official" ? "codex" : sourceId.slice(7);
            const client = informationClient(clientId);
            const account = client?.accounts.find(
              (a) => a.id === accountId && a.kind !== "api",
            );
            const provider = informationProvider(client, account);
            if (!provider) throw Error("此账户没有可查询的额度接口");
            return refreshAccountInfo(provider.id, {
              automatic: automatic === true,
            });
          }
          const provider = store.state.providers.find((p) => p.id === sourceId);
          if (!provider) throw Error("供应商不存在");
          return accountInfo.public(provider).canRefresh
            ? refreshAccountInfo(provider.id, {
                automatic: automatic === true,
              })
            : balance(sourceId, automatic === true);
        },
      );
      // Injection consumes durable observations only. It must never await a
      // provider request; testing belongs to model creation/the lightning button.
      register("connection-preview", async (scope, enabled, quit, accountless) => {
        if (scope === "claude" && enabled && !quit &&
            (accountless === true || (accountless === undefined && proxyConfig.clients.claude?.accountless))) {
          const launcher = harnesses.launcher("claude");
          if (!launcher.ready && !harnesses.desktop("claude")) throw Error(launcher.message);
          if (launcher.ready) await require("../core/accountless.cjs").assertClaudePicker(launcher);
        }
        return connections.preview(scope, enabled, quit, accountless);
      });
      register("connection-repair-preview", (scope) => connections.repairPreview(scope));
      register("connections-refresh", () => connections.refreshAll({ assertIdle: id => nativeLogin.assertIdle(id) }));
      register("connection-repair", async (input) => {
        for (const id of connections.tickets.get(input?.ticket)?.ids || [])
          await nativeLogin.assertIdle(id);
        return connections.repairApply(input);
      });
      register("app-exit-preview", exitStatus);
      register("app-exit-direct", (acknowledged) => connections.directExit(acknowledged, () => {
        // Intentionally do not run connection-apply or change any persisted
        // injection, accountless, desktop-gateway or connection-enabled state.
        finishDirectExit();
      }));
      register("connection-apply", async (input) => {
        const plan = connections.tickets.get(input?.ticket);
        for (const id of plan?.ids || [])
          await nativeLogin.assertIdle(id);
        if (plan?.quit) claudeDesktop.preflightDisable();
        diagnosticBatch.cancel();
        for (const controller of diagnosticControllers.values())
          controller.abort();
        const result = await connections.apply(input);
        if (result.quit) {
          // A safe exit is not successful if the desktop still points at a
          // route we just stopped. Leave ASS open and report the restore error.
          claudeDesktop.disable();
          quitting = true;
          setImmediate(() => app.quit());
          return result;
        }
        return result;
      });
      register("update-check", () => updates.check({ manual: true }));
      register("update-preferences", (input) => updates.preferences(input));
      register("update-dismiss", () => updates.dismiss());
      register("update-open", (kind) =>
        shell.openExternal(updates.openUrl(kind)),
      );
      register("official-open", (id, target) => {
        const service = OFFICIAL_SERVICES.find((s) => s.id === id);
        if (!service || !["console", "docs"].includes(target))
          throw Error("未知官方入口");
        return shell.openExternal(service[target]);
      });
      register("account-info", async (clientId, accountId) => {
        const client = informationClient(clientId);
        const account = client?.accounts.find((a) => a.id === accountId);
        if (!account) throw Error("账户不存在");
        const provider = informationProvider(client, account);
        if (!provider) throw Error("此账户没有可查询的官方资料接口");
        return refreshAccountInfo(provider.id);
      });
      register("account-info-doc", (id) => {
        if (!Object.hasOwn(ACCOUNT_DOCS, id)) throw Error("未知资料文档");
        return shell.openExternal(ACCOUNT_DOCS[id].url);
      });
      register("native-key-save", (input) => nativeKeys.save(input));
      register("native-key-remove", async (id) => {
        const result = await dialog.showMessageBox(window, {
          type: "warning",
          message: "从 ASS 移除此原生 API Key？",
          detail: "只删除本机加密副本，不会撤销供应商端的 Key。",
          buttons: ["取消", "移除"],
          defaultId: 0,
          cancelId: 0,
        });
        if (result.response === 1) nativeKeys.remove(id);
      });
      register("native-key-copy", (id) => {
        const secret = nativeKeys.read(id);
        clipboard.writeText(secret);
        const timer = setTimeout(() => {
          if (clipboard.readText() === secret) clipboard.clear();
        }, 30000);
        timer.unref();
        return {
          ok: true,
          message:
            "已复制到系统剪贴板，30 秒后清理当前副本。剪贴板历史或其他应用可能保留副本。",
        };
      });
      register("openrouter-auth-start", (label, client) => {
        if (client) throw Error("OpenRouter 属于模型供应商，请在供应商页面授权");
        return openRouterAuth.start(label, client);
      });
      register("openrouter-auth-cancel", () => openRouterAuth.cancel());
      register("account-add", (id, label, oauthProvider) =>
        harnesses.add(id, label, oauthProvider),
      );
      register("client-refresh", refreshClientState);
      register("native-login-preview", async (id) => {
        if (connections.busy) throw Error("正在修改客户端接入，请稍后登录");
        return nativeLogin.preview(id);
      });
      register("native-login-apply", (ticket, choice, confirmed) => connections.launch(() =>
        nativeLogin.apply(ticket, choice, confirmed)));
      register("oauth-switch-preview", async (id, account) => {
        if (connections.busy) throw Error("正在修改客户端接入，请稍后切换账户");
        await nativeLogin.assertIdle(id);
        const local = ["codex", "claude"].includes(id) ? await conversations.list({ harness: id }) : null;
        const preview = oauthHistory.preview(id, account);
        await processes.refresh();
        const lifecycle = ["codex", "claude"].includes(id) ? await restarter.preview([id]) : null;
        oauthHistory.tickets.get(preview.ticket).lifecycle = lifecycle;
        return { ...preview, lifecycle: restarter.public(lifecycle), conversations: local ? { count: local.count, retained: local.retained } : null };
      });
      register("oauth-switch-apply", (ticket, confirmed, mode = "none") => connections.launch(() =>
        switchClientAccount({ history: oauthHistory, library: conversations, restarter, router, blocked: connections.blocked,
          ticket, confirmed, mode, selectTarget: (id) => harnesses.selectOAuthTarget(id), assertIdle: (id) => nativeLogin.assertIdle(id),
          extraActive: () => probeControllers.size + diagnosticControllers.size })));
      register("conversations-list", (input) => conversations.list(input));
      register("conversation-open-link", async (value) => {
        const { conversationUrl } = await import('../core/conversation-url.mjs');
        const url = conversationUrl(value);
        if (!url || url.startsWith('#')) throw Error('不支持打开此链接');
        return shell.openExternal(url);
      });
      register("project-conversations-list", (input) => projectConversations.list(input));
      register("project-conversations-search", (input) => projectConversations.search(input));
      register("project-conversations-delete", (input) => projectConversations.remove(input));
      register("project-conversations-trash", (input) => projectConversations.trashList(input));
      register("project-conversations-trash-purge", (input) => projectConversations.purgeTrash(input));
      register("project-conversations-restore", (id) => projectConversations.restoreTrash(id));
      register("project-conversations-configure", (id, options) => projectConversations.configure(id, options));
      register("project-conversations-sync", (id) => projectConversations.sync(id));
      register("project-conversations-threads", (id, input) => projectConversations.threads(id, input));
      register("project-conversations-records", (id, input) => projectConversations.records(id, input));
      register("project-conversations-native-preview", (id, before) => {
        const row = projectConversations.record(id);
        return row.libraryId ? conversations.preview(row.libraryId, before) : projectConversations.nativePreview(id, before);
      });
      register("project-conversations-native-resume", (id) => connections.launch(async () => {
        const row = projectConversations.record(id), launcher = harnesses.launcher(row.harness);
        if (!launcher.ready) throw Error(launcher.message);
        const plan = row.libraryId ? harnesses.conversationPlan(row.harness, row)
          : harnesses.projectConversationPlan(row.harness, row.cwd, row.sessionId, row.file);
        if (row.libraryId) { const staged = await conversations.stage(row.libraryId, plan.dir); if (row.harness === 'claude') plan.args = ['--resume', staged.file]; }
        if (connections.enabled[row.harness] && connections.needsRouter(row.harness) && !router.server) await router.start(servicePort);
        const result = await harnesses.launchPlan(row.harness, plan, 'conversation:' + row.sessionId, 'resume', launcher);
        return { ...result, message: result.message || (row.harness === 'dsh' ? plan.hint : '已打开原客户端会话，使用当前账户。') };
      }));
      register("project-conversations-preview", (id, thread, before, history) => projectConversations.preview(id, thread, before, history));
      register("project-conversations-resume", (id, thread, harness) => connections.launch(async () => {
        const launcher = harnesses.launcher(harness); if (!launcher.ready) throw Error(launcher.message);
        const project = projectConversations.project(id), initial = harnesses.projectConversationPlan(harness, project.cwd);
        if (harness === 'opencode' && !initial.targetModel) throw Error('OpenCode 尚未选择当前模型，请先配置 provider/model；不会使用同步记录中的历史模型');
        const prepared = await projectConversations.prepare(id, thread, harness, initial.dir,
          harness === 'opencode' ? require('../core/opencode-version.cjs').version(harnesses.launcher(harness), initial.dir) : 1, initial.targetModel);
        if (harness === "opencode") {
          const preCodecs = require('../core/project-codecs.cjs'), preContract = require('../core/opencode-version.cjs');
          if (fs.existsSync(path.join(initial.dir, 'opencode.db'))) {
            try { const current = preCodecs.openCodeBundle(path.join(initial.dir, 'opencode.db'), prepared.sessionId);
              if (!preContract.equal(current, JSON.parse(fs.readFileSync(prepared.file, 'utf8')))) throw Error('OpenCode 已有同 ID 的其他内容，未覆盖');
            } catch (error) { if (!/会话不存在/.test(error.message)) throw error; }
          }
          // Use the official importer: never splice rows into a live native DB.
          await new Promise((resolve, reject) => require("node:child_process").execFile(launcher.executable,
            [...launcher.args, ...require('../core/opencode-version.cjs').command(require('../core/opencode-version.cjs').version(launcher, initial.dir), 'import', prepared.file)], { cwd: project.cwd, env: initial.env, windowsHide: true, timeout: 30000, maxBuffer: 1024 ** 2 },
            (error) => error ? reject(Error("OpenCode 原生导入失败，共享记录已保留；请确认 CLI 版本支持 import")) : resolve()));
          const codecs = require('../core/project-codecs.cjs'), contract = require('../core/opencode-version.cjs');
          const expected = JSON.parse(fs.readFileSync(prepared.file, 'utf8'));
          const imported = codecs.openCodeBundle(path.join(initial.dir, 'opencode.db'), prepared.sessionId);
          if (!contract.equal(imported, expected) || codecs.pathKey(contract.cwd(imported)) !== codecs.pathKey(project.cwd))
            throw Error('OpenCode 导入身份或内容不一致，共享记录已保留');
        }
        const plan = harnesses.projectConversationPlan(harness, project.cwd, prepared.sessionId, prepared.nativeFile);
        if (connections.enabled[harness] && connections.needsRouter(harness) && !router.server) await router.start(servicePort);
        const result = await harnesses.launchPlan(harness, plan, "project:" + id, "resume", launcher);
        return { ...result, mode: prepared.mode, message: harness === "dsh" ? plan.hint : "已在当前客户端继续共享对话；已完成的新内容将自动同步。" };
      }));
      register("conversations-preview", (id, before) => conversations.preview(id, before));
      register("conversations-backups", (input) => conversations.backups(input));
      register("conversations-backup-preview", (id, before) => conversations.backupPreview(id, before));
      register("conversations-backup-cleanup", (input) => conversations.cleanupBackups(input));
      register("conversations-backup-restore", (id) => connections.launch(async () => {
        const row = conversations.lookup(id), plan = harnesses.conversationPlan(row.harness, row);
        return conversations.restoreBackup(id, plan.dir);
      }));
      register("conversations-pin", (id, value) => conversations.pin(id, value));
      register("conversations-preserve", (id) => connections.launch(() => conversations.preserve(id)));
      register("conversations-resume", (id) => connections.launch(async () => {
        const row = conversations.resumeRow(id), launcher = harnesses.launcher(row.harness);
        if (!launcher.ready) throw Error(launcher.message);
        // Validate the CURRENT login before restoring any transcript. The file's
        // former home and account are never used as a credential source.
        const plan = harnesses.conversationPlan(row.harness, row);
        const staged = await conversations.stage(row.id, plan.dir);
        if (row.harness === "claude") plan.args = ["--resume", staged.file];
        if (connections.enabled[row.harness] && connections.needsRouter(row.harness) && !router.server)
          await router.start(servicePort);
        return harnesses.launchPlan(row.harness, plan, "conversation:" + row.sessionId, "resume", launcher);
      }));
      register("conversations-open-desktop", (id) => connections.launch(async () => {
        const row = conversations.lookup(id);
        if (row.harness !== "codex" || !harnesses.desktop("codex")) throw Error("此操作仅支持已安装的 Codex 桌面版");
        const plan = harnesses.conversationPlan("codex", row);
        if (path.resolve(plan.dir).toLowerCase() !== path.resolve(harnesses.codexDir).toLowerCase())
          throw Error("此凭据目录不是 Codex 桌面默认目录，请用 CLI 继续，或在客户端设置中恢复默认目录");
        await conversations.stage(id, plan.dir);
        if (connections.enabled.codex && !router.server) await router.start(servicePort);
        await shell.openExternal("codex://threads/" + row.sessionId);
        return { ok: true, message: "已向 Codex 桌面打开本地对话；刚切换 OAuth 时请先自行重启桌面，使新登录生效。" };
      }));
      register("conversations-location", (id) => {
        const row = conversations.lookup(id);
        require("../core/native-fields.cjs").safePath(row.file);
        if (!fs.existsSync(row.file)) throw Error("原记录不存在，可从已保留副本继续对话");
        shell.showItemInFolder(row.file); return { ok: true };
      });
      register("pi-import-oauth", async (sourceId, label) => {
        const source = harnesses.oauthSources().find((s) => s.id === sourceId);
        if (!source) throw new Error("授权来源已变化，请刷新");
        const r = await dialog.showMessageBox(window, {
          type: "warning",
          message: "将 " + source.label + " 的授权导入新的 pi 账户？",
          detail:
            "来源凭据不修改。导入后两端各自刷新令牌，刷新或撤销可能使另一端失效。授权的可用性、权益与计费由供应商决定。",
          buttons: ["取消", "导入到 pi"],
          defaultId: 0,
          cancelId: 0,
        });
        if (r.response !== 1) return null;
        return harnesses.importOAuth(sourceId, label);
      });
      register("account-select", (id, account) =>
        harnesses.select(id, account),
      );
      register("account-bind-api", (id, provider, enabled = true) =>
        harnesses.bindApi(id, provider, enabled),
      );
      register("account-save-api", (id, input) => {
        const provider = accountTransactions.saveBoundApi(
          store,
          harnesses,
          id,
          input,
        );
        invalidateReports(provider);
        return provider;
      });
      register("client-model", (id, account, model) =>
        harnesses.selectModel(id, account, model),
      );
      register("client-injection", (id, changes) => harnesses.setInjection(id, changes));
      register("client-native-variant", (id, variant) => harnesses.setNativeVariant(id, variant));
      register("client-model-launch", (id, ref) => connections.launch(async () => {
        if (connections.enabled[id] && connections.needsRouter(id) && !router.server)
          await router.start(servicePort);
        return harnesses.launchModel(id, ref, router.clientToken);
      }));
      register("client-accountless-launch", (id) => connections.launch(async () => {
        harnesses.accountlessPlan(id, router.clientToken);
        if (!router.server) await router.start(servicePort);
        return harnesses.launchAccountless(id, router.clientToken);
      }));
      register("claude-desktop-copy", async (kind) => {
        if (!["url", "key"].includes(kind)) throw Error("无效的桌面版接入信息");
        const applied = proxyConfig.clients.claude;
        if (!connections.enabled.claude || !applied?.accountless || !proxyConfig.status("claude", true).applied)
          throw Error("请先完成 Claude Code 的模型接入和无账号配置");
        if (!router.server) await router.start(servicePort);
        clipboard.writeText(kind === "url"
          ? `http://127.0.0.1:${servicePort}/clients/claude/models`
          : applied.localToken);
        return { ok: true };
      });
      register("client-credentials", async (id, reset = false) => {
        if (reset) return harnesses.setCredentialHome(id, "");
        const result = await dialog.showOpenDialog(window, {
          title: "选择 " + harnesses.spec(id).name + " 凭据目录",
          properties: ["openDirectory"],
        });
        if (!result.canceled)
          harnesses.setCredentialHome(id, result.filePaths[0]);
      });
      register("client-detect", async (id) => {
        const candidates = harnesses.detect(id);
        let launcher = harnesses.launcher(id);
        if (!launcher.ready && !launcher.installed) {
          const ready = candidates.filter(c => c.ready);
          launcher = ready.length === 1 ? ready[0] : candidates.length === 1 ? candidates[0] : launcher;
        }
        const selected = launcher.ready || launcher.installed ? launcher.location : "";
        if (selected) harnesses.setExecutable(id, selected);
        return { candidates, selected, snapshot: await refreshClientState() };
      });
      register("client-open-desktop", async (id) => {
        if (id === 'codex') return openCodexDesktop({
          desktop: () => harnesses.desktop('codex'), rediscover: () => harnesses.detect('codex'),
          workspaceOptions: codexWorkspaceLaunchOptions, preview: () => restarter.preview(['codex']),
          openNative: executable => shell.openPath(executable), accountless: !!proxyConfig.clients.codex?.accountless,
        });
        if (id === "claude" && proxyConfig.clients.claude?.accountless &&
            (!proxyConfig.status("claude", true).applied ||
              !claudeDesktop.status(proxyConfig.clients.claude.localToken, servicePort).current))
          throw Error("Claude 桌面版无账号配置尚未同步，请先同步接入后再启动");
        const executable = harnesses.desktop(id);
        if (!executable)
          throw Error("未找到已安装的桌面客户端，请重新自动识别");
        const error = await shell.openPath(executable);
        if (error) throw Error("无法打开桌面客户端，请检查安装文件");
        return {
          ok: true,
          message:
            proxyConfig.clients[id]?.accountless ? id === "claude"
              ? "已打开 Claude 桌面版；若出现 Gateway 提示，选择继续即可。已有窗口需在任务结束后重新打开。"
              : "已打开 Codex 桌面端。若已有窗口仍使用旧配置，请结束任务后通过接入菜单重启。"
              : "已打开 " + harnesses.spec(id).name + " 桌面端；沿用其原生账户，没有注入或切换凭据。",
        };
      });
      register("client-location", async (id, location) => {
        harnesses.setExecutable(id, location);
        return { snapshot: await refreshClientState() };
      });
      register("client-executable", async (id, directory = false) => {
        const r = await dialog.showOpenDialog(window, {
          title: directory ? "选择客户端安装或源码目录" : "选择客户端启动文件",
          properties: [directory ? "openDirectory" : "openFile"],
          ...(directory
            ? {}
            : {
                filters: [
                  {
                    name: "客户端",
                    extensions: ["exe", "cmd", "ps1", "js", "cjs", "mjs"],
                  },
                ],
              }),
        });
        if (!r.canceled) {
          harnesses.setExecutable(id, r.filePaths[0]);
          return { snapshot: await refreshClientState() };
        }
      });
      register("client-workspace", async () => {
        const r = await dialog.showOpenDialog(window, {
          title: "选择客户端工作目录",
          properties: ["openDirectory"],
        });
        if (!r.canceled) {
          harnesses.state.workspace = r.filePaths[0];
          harnesses.save();
          await syncNativeSuppliers();
        }
      });
      register("client-launch", async (id, account, action, model) => {
        if (action === "logout") {
          const r = await dialog.showMessageBox(window, {
            type: "warning",
            message: "打开此账户的原生退出流程？",
            detail: "将作用于此卡片对应的凭据目录，可能影响正在运行的会话。",
            buttons: ["取消", "继续"],
            defaultId: 0,
            cancelId: 0,
          });
          if (r.response !== 1) return { ok: true, message: "已取消" };
        }
        return connections.launch(async () => {
          if (["codex", "claude"].includes(id) && ["login", "logout"].includes(action))
            await conversations.preserve(id);
          if (
            connections.enabled[id] &&
            connections.needsRouter(id) &&
            !router.server
          )
            await router.start(servicePort);
          return harnesses.launch(
            id,
            account,
            action,
            model,
            router.clientToken,
          );
        });
      });
      register("import", async () => {
        const chosen = await dialog.showOpenDialog(window, {
          title: "导入供应商配置",
          properties: ["openFile"],
          filters: [{ name: "路由配置", extensions: ["json"] }],
        });
        if (chosen.canceled) return null;
        const file = chosen.filePaths[0];
        const result = store.import(require('../core/config-limits.cjs').readConfigFile(file));
        invalidateReports();
        queueProtocolChecks();
        return result;
      });
      register("save-provider", (input) => {
        const id = store.updateProvider(input);
        invalidateReports(id);
        queueProtocolChecks(id);
        return id;
      });
      register("delete-provider", async (id) => {
        const r = await dialog.showMessageBox(window, {
          type: "warning",
          message: "移除此供应商和它的模型？",
          detail: "已保存的 API Key 也将从本应用移除。",
          buttons: ["取消", "移除"],
          defaultId: 0,
          cancelId: 0,
        });
        if (r.response === 1) {
          store.removeProvider(id);
          invalidateReports(id);
        }
      });
      register("save-model", (provider, model, originalName, expected) => {
        accountTransactions.saveModel(
          store,
          harnesses,
          provider,
          model,
          originalName,
          expected,
        );
        invalidateReports(provider, false);
        queueProtocolChecks(provider, model.model);
      });
      register("delete-model", (provider, name, expected) => {
        // The trusted renderer confirms next to the model's delete button.
        // Keep the selected snapshot mandatory to reject stale confirmations.
        if (!expected || expected.model !== name)
          throw Error("请重新选择要删除的模型");
        accountTransactions.deleteModel(
          store,
          harnesses,
          provider,
          name,
          expected,
        );
        invalidateReports(provider, false);
        return { removed: true };
      });
      register("model-defaults", (provider, model) =>
        normalizeModel({ model }, provider, store.officialModels),
      );
      register("diagnose", (id, model) => {
        if (diagnosticBatch.state.running) throw Error("一键测试正在进行");
        return diagnose(id, model);
      });
      register("diagnose-all", () => {
        if (
          connections.busy ||
          diagnosticControllers.size ||
          probeControllers.size
        )
          throw Error("请等待当前检测或接入切换完成");
        return diagnosticBatch.start();
      });
      register("diagnose-cancel", () => diagnosticBatch.cancel());
      register("models-discover", readModelMetadata);
      register("capabilities-probe", async (id, name) => {
        if (connections.busy) throw Error("正在切换接入，请稍后检测");
        const p = store.state.providers.find((p) => p.id === id),
          m = p?.models.find((m) => m.model === name);
        if (!m)
          throw Error(
            "请选择具体模型；官方订阅模型请读取本机目录并使用闪电检测连接",
          );
        const result = await dialog.showMessageBox(window, {
          type: "question",
          message: "实测 " + m.model + " 的上游能力？",
          detail:
            "最多 " +
            (5 + m.efforts.length) +
            " 条小请求，每条最多请求 512 输出 tokens，可能计费。检测协议、工具调用及已配置的思维档位；不执行工具，不盲测上下文上限，不修改模型配置。",
          buttons: ["取消", "开始实测"],
          defaultId: 0,
          cancelId: 0,
        });
        if (result.response !== 1) return null;
        return probeModel(id, name);
      });
      register("capabilities-cancel", (id, name) =>
        probeControllers.get(modelKey(id, name))?.abort(),
      );
      register("model-add-discovered", (id, name) => {
        if (id === "official") {
          const source = store.officialModels.find((m) => m.slug === name);
          if (!source) throw Error("本机官方目录中没有该模型");
          store.model(id, {
            model: name,
            displayName: source.display_name,
            wireApi: "openai-responses",
          });
          return;
        }
        const p = store.state.providers.find((p) => p.id === id);
        const found = providerModels[id]?.models.find((m) => m.model === name);
        if (!p || !found) throw Error("请先读取供应商模型目录");
        if (p.models.some((m) => m.model === name))
          throw Error("模型已在配置中");
        const d = found.declared;
        const efforts = d.efforts.filter(
          (e) =>
            e !== "ultra" ||
            name.split("/").at(-1).toLowerCase().startsWith("gpt"),
        );
        store.model(id, {
          model: name,
          displayName: found.displayName,
          ...(d.contextWindow >= 4096 && d.contextWindow <= 10000000
            ? {
                contextWindow: d.contextWindow,
                contextSource: "供应商 /models 声明（未实测）",
              }
            : {}),
          ...(d.maxOutputTokens ? { maxOutputTokens: d.maxOutputTokens } : {}),
          ...(efforts.length ? { efforts } : {}),
        });
        queueProtocolChecks(id, name);
      });
      register("balance", balance);
      register("autostart", (enabled) => {
        app.setLoginItemSettings({
          openAtLogin: !!enabled,
          path: process.execPath,
          args: app.isPackaged ? ["--hidden"] : [app.getAppPath(), "--hidden"],
        });
        store.state.autoStart = !!enabled;
        store.save();
      });
      register("open-data", () => shell.openPath(dataDir));
      register("export", async (options) => {
        const config = exportConfig(store.state.providers, options);
        const includeSecrets = options?.includeSecrets === true;
        const result = await dialog.showSaveDialog(window, {
          title: includeSecrets ? "导出配置（包含明文密钥）" : "导出配置（不含密钥）",
          defaultPath: includeSecrets ? "ass-config-with-keys.json" : "ass-config.json",
          filters: [{ name: "JSON 配置", extensions: ["json"] }],
        });
        if (result.canceled || !result.filePath) return { saved: false };
        atomic(result.filePath, JSON.stringify(config, null, 2));
        return { saved: true, includeSecrets };
      });
      const image = nativeImage.createFromPath(iconPath);
      tray = new Tray(image.resize({ width: 24, height: 24 }));
      tray.setToolTip("ASS · 模型随你切");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "打开 ASS", click: showWindow },
          {
            label: "检查 ASS 更新",
            click: () => {
              showWindow();
              void updates.check({ manual: true });
            },
          },
          { type: "separator" },
          {
            label: "退出…",
            click: () => {
              requestExit();
            },
          },
        ]),
      );
      tray.on("double-click", showWindow);
      if (!process.argv.includes("--hidden")) showWindow();
      const importArg = process.argv.find((x) =>
        x.startsWith("--import-config="),
      );
      if (importArg) {
        store.import(require('../core/config-limits.cjs').readConfigFile(importArg.slice(16)));
      }
      if (testMode)
        global.assTest = {
          store,
          router,
          config,
          harnesses,
          nativeConfig,
          nativeKeys,
          oauthHistory,
          conversations,
          projectConversations,
          nativeLogin,
          accountInfo,
          preferences,
          openRouterAuth,
          updates,
          connections,
          restarter,
          processes,
          setFetch: (value) => {
            testFetch = value;
          },
          diagnose,
          diagnosticHistory,
          diagnosticBatch,
          readModelMetadata,
          syncNativeSuppliers,
          refreshAccountInfo,
          probeModel,
          protocols,
          prepareProtocols,
          balance,
          requestExit,
          snapshot,
          upstream,
          readAuth,
          routeFor: require("../core/router.cjs").routeFor,
          quit: () => {
            quitting = true;
            app.quit();
          },
        };
      oauthHistory.start();
      if (!testMode) void runtimeHealth.background('native-scan', syncNativeSuppliers);
      if (!testMode) updates.start();
    })
    .catch((error) => {
      dialog.showErrorBox("ASS 启动失败", error.message);
      app.exit(1);
    });
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    if (!quitting && !testMode && connections) {
      event.preventDefault();
      requestExit();
      return;
    }
    quitting = true;
    runtimeHealth?.record('exit');
    publisher.clear();
    updates?.stop();
    oauthHistory?.stop();
    projectConversations?.stop();
    modelDirectory.invalidate();
    diagnosticBatch.cancel();
    for (const controller of diagnosticControllers.values()) controller.abort();
    for (const controller of probeControllers.values()) controller.abort();
    openRouterAuth?.cancel();
    router?.stop();
    void codexWorkspaceRelay?.stop();
  });
}
