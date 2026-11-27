const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { versionSupported } = require("./agy-injection.cjs");

const KIND = "antigravity-quota";
const UPDATE_REQUIRED = "只读额度查询需要 Antigravity CLI 1.1.11 或更新版本";
const LOGIN_REQUIRED = "Antigravity 登录已失效，请重新登录后查询额度";
const NATIVE_OAUTH_REQUIRED = "当前环境使用 Gateway 或 Google Cloud ADC，无法查询原生 OAuth 额度";
const label = (value) =>
  typeof value === "string" && value.trim() && value.length <= 180 && !/[\x00-\x1f\x7f]/.test(value)
    ? value.trim()
    : "";
const windowLabel = (id) => /-(5h|weekly)$/.exec(id)?.[1];

function displayFields(fields) {
  // Older cached rows used the full upstream title. Their IDs retain the window.
  return fields.map((field) => {
    if (field.kind !== "quota") return field;
    const { resetsAt, ...rest } = field;
    const short = /\s/.test(field.label) && windowLabel(field.id);
    return { ...rest, label: short || field.label, ...(validReset(resetsAt) ? { resetsAt } : {}) };
  });
}

// agy can report an unset 5h reset as the Unix epoch on an untouched pool.
const validReset = (value) => typeof value === "string" && Date.parse(value) > 0;

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(text || "").trim());
  if (!match) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const raw = `${major}.${minor}.${patch}`;
  return {
    raw,
    major,
    minor,
    patch,
    quotaSupported: major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 11))),
    customModelsSupported: versionSupported(raw),
  };
}

function provider(client, account) {
  const launcher = client.launcher;
  if (
    account.provider !== "google-antigravity" ||
    !account.quotaAvailable ||
    client.credentialHome ||
    !launcher?.ready ||
    launcher.nativeVariant !== "cli" ||
    !path.isAbsolute(launcher.executable) ||
    path.basename(launcher.executable).toLowerCase() !== "agy.exe"
  )
    return null;
  return {
    id: "native-info:antigravity:" + account.id,
    subscriptionKind: KIND,
    executable: launcher.executable,
  };
}

function parseQuota(command, output) {
  if (output?.status === "ERROR" && authenticationRequired(output.error)) throw Error(LOGIN_REQUIRED);
  if (output?.status !== "SUCCESS" || output.command?.name !== command)
    throw Error("接口未返回可识别的账户资料");
  const data = output.command.data;
  if (command === "credits") {
    const balance = data?.remaining_credits;
    if (!Number.isFinite(balance) || balance < 0) throw Error("接口未返回可识别的账户资料");
    return [
      { id: "balance-antigravity-credits", label: "剩余点数", value: String(balance), kind: "amount", unit: "点" },
    ];
  }
  if (command !== "usage" || !Array.isArray(data?.groups)) throw Error("接口未返回可识别的账户资料");
  const buckets = new Map();
  for (const section of data.groups) {
    if (!Array.isArray(section?.buckets)) continue;
    const group = label(section.name);
    for (const bucket of section.buckets) {
      const id = label(bucket?.id),
        name = label(bucket?.window) || windowLabel(id) || label(bucket?.name),
        remaining = bucket?.remaining_fraction;
      if (!id || !name || !Number.isFinite(remaining) || remaining < 0 || remaining > 1 || buckets.has(id)) continue;
      const reset = validReset(bucket.reset_time) ? new Date(bucket.reset_time).toISOString() : null;
      const remainingPercent = remaining * 100;
      const usedPercent = 100 - remainingPercent;
      buckets.set(id, {
        id: "quota-antigravity-" + id,
        label: name,
        group,
        kind: "quota",
        value: String(usedPercent),
        usedPercent,
        remainingPercent,
        ...(remaining === 0 ? { status: "rate-limited" } : {}),
        ...(reset ? { resetsAt: reset } : {}),
      });
    }
  }
  if (!buckets.size) throw Error("未返回订阅额度窗口");
  return [...buckets.values()];
}

function parseModelsOutput(stdout) {
  const models = [];
  const seen = new Set();
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^fetching\b/i.test(line)) continue;
    const tab = line.indexOf("\t");
    let id, name;
    if (tab > 0) {
      id = label(line.slice(0, tab));
      name = label(line.slice(tab + 1)) || id;
    } else {
      const m = /^([^\s]+)\s{2,}(.+)$/.exec(line);
      id = label(m ? m[1] : line);
      name = label(m ? m[2] : line) || id;
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: name });
  }
  return models;
}

function parseCurrentModel(output) {
  if (output?.status !== "SUCCESS" || output.command?.name !== "model") return null;
  const d = output.command.data;
  const id = label(d?.id);
  const name = label(d?.label) || id;
  if (!id && !name) return null;
  return {
    id,
    label: name,
    effort: label(d?.effort) || "",
    isDefault: d?.is_default === true,
  };
}

function parseEffort(output) {
  if (output?.status !== "SUCCESS" || output.command?.name !== "effort") return null;
  const d = output.command.data;
  const current = label(d?.current);
  const available = Array.isArray(d?.available) ? d.available.map(label).filter(Boolean) : [];
  return {
    adjustable: d?.adjustable === true,
    current,
    available,
  };
}

function authenticationRequired(message) {
  return typeof message === "string" && /\bauthentication required\b/i.test(message);
}

function readCommandArgs(command) {
  return ["-p", "/" + command, "--disable-slash-commands=false", "--output-format", "json"];
}

function agy(executable, args, timeout = 15000, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      {
        cwd: os.homedir(),
        env,
        windowsHide: true,
        timeout,
        maxBuffer: 512 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error)
          return reject(
            error.killed ? Object.assign(Error(), { name: "TimeoutError" })
              : Error(authenticationRequired(stderr) ? LOGIN_REQUIRED : "无法调用 Antigravity CLI"),
          );
        resolve(stdout);
      },
    );
    child.stdin?.end();
  });
}

function requests(providerInfo, { run = agy, env = process.env } = {}) {
  // Earlier CLI versions can treat a slash command in print mode as a prompt.
  const accountOverride = Object.entries(env).some(([name, value]) =>
    (/^AGY_LLM_GATEWAY_URL$/i.test(name) && value?.trim()) ||
    (/^AGY_ADC_AUTH$/i.test(name) && /^(?:true|t|1)$/i.test(value?.trim())));
  let version;
  return [
    ["usage", "Antigravity 订阅额度"],
    ["credits", "Antigravity 点数"],
  ].map(([section, sectionLabel]) => ({
    section,
    label: sectionLabel,
    run: async () => {
      if (accountOverride) throw Error(NATIVE_OAUTH_REQUIRED);
      version ||= run(providerInfo.executable, ["--version"], 8000, env);
      const parsed = parseVersion(await version);
      if (!parsed?.quotaSupported) throw Error(UPDATE_REQUIRED);
      const stdout = await run(providerInfo.executable, readCommandArgs(section), 15000, env);
      return { data: JSON.parse(stdout) };
    },
  }));
}

async function inspectCli(executable, { run = agy } = {}) {
  if (!executable || !path.isAbsolute(executable)) {
    throw Error("未找到 Antigravity CLI 可执行文件");
  }
  const versionRaw = await run(executable, ["--version"], 8000);
  const version = parseVersion(versionRaw);
  if (!version) throw Error("无法识别 Antigravity CLI 版本");

  let currentModel = null;
  let effort = null;
  let models = [];
  const errors = [];

  if (version.quotaSupported) {
    const [modelRes, effortRes, catalogRes] = await Promise.allSettled([
      run(executable, readCommandArgs("model"), 12000),
      run(executable, readCommandArgs("effort"), 12000),
      run(executable, ["models"], 15000),
    ]);
    if (modelRes.status === "fulfilled") {
      try { currentModel = parseCurrentModel(JSON.parse(modelRes.value)); } catch { errors.push("当前模型解析失败"); }
    }
    if (effortRes.status === "fulfilled") {
      try { effort = parseEffort(JSON.parse(effortRes.value)); } catch { errors.push("思维强度解析失败"); }
    }
    if (catalogRes.status === "fulfilled") {
      models = parseModelsOutput(catalogRes.value);
    } else {
      errors.push("模型目录读取失败");
    }
  }

  return {
    version: version.raw,
    quotaSupported: version.quotaSupported,
    customModelsSupported: version.customModelsSupported,
    currentModel,
    effort,
    models,
    updatedAt: new Date().toISOString(),
    error: errors.join("；"),
  };
}

module.exports = {
  KIND,
  UPDATE_REQUIRED,
  LOGIN_REQUIRED,
  NATIVE_OAUTH_REQUIRED,
  provider,
  parseVersion,
  parseQuota,
  parseModelsOutput,
  parseCurrentModel,
  parseEffort,
  requests,
  displayFields,
  inspectCli,
};
