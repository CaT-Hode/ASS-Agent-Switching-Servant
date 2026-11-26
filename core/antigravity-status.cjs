// Read-only Antigravity native login inventory. Storage constants and the
// StoredToken JSON schema come from the official agy 1.2.9 Windows artifact;
// see docs/antigravity-native.md. Never read Gemini CLI's oauth_creds.json.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile, execFileSync, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { text, claims } = require("./account-info.cjs");
const { safePath } = require("./native-fields.cjs");

const TOKEN_FILE = "jetski-standalone-oauth-token";
const KEYRING_SOURCE = "Windows 凭据管理器 · gemini:antigravity";
const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const has = (v) => typeof v === "string" && !!v.trim();
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const digest = (v) => createHash("sha256").update(v).digest("hex").slice(0, 20);
const variants = { "antigravity-cli": "cli", antigravity: "desktop", "antigravity-ide": "ide" };
const labels = { cli: "Antigravity CLI", desktop: "Antigravity 2.0", ide: "Antigravity IDE", custom: "Antigravity" };
const powershell = () => path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
const encoded = (script) => Buffer.from(script, "utf16le").toString("base64");
const authorization = (access, refresh, seconds, now = Date.now()) => {
  const n = Number(seconds), expiresAt = Number.isFinite(n) && n > 0 && n < 8.64e12 ? n * 1000 : null;
  const expired = expiresAt !== null && expiresAt <= now;
  return { authType: "oauth", ready: has(access) && (!expired || has(refresh)), expiresAt,
    status: !has(access) ? "incomplete" : expired ? has(refresh) ? "refresh-required" : "expired" : "detected",
    message: !has(access) ? "OAuth 凭据不完整" : expired ? has(refresh) ? "访问令牌已到期 · 由客户端刷新" : "授权已到期 · 需要重新登录" : "OAuth" };
};

function locations({ home, override }) {
  if (override) {
    const dir = path.resolve(override.replace(/^~(?=[/\\]|$)/, home));
    return [{ dir, variant: variants[path.basename(dir).toLowerCase()] || "custom" }];
  }
  return Object.entries(variants).map(([name, variant]) => ({ dir: path.join(home, ".gemini", name), variant }));
}
function credentialRoot(options) {
  if (!options.override) return path.join(options.home, ".gemini");
  const { dir, variant } = locations(options)[0];
  return variant !== "custom" && path.basename(path.dirname(dir)).toLowerCase() === ".gemini" ? path.dirname(dir) : dir;
}
function directorySource(dir) {
  try {
    safePath(dir);
    return { file: dir, status: fs.statSync(dir).isDirectory() ? "detected" : "unreadable" };
  } catch (e) { return { file: dir, status: e.code === "ENOENT" ? "missing" : "unreadable" }; }
}
function filePreferred(root, now) {
  // Native keyring-unavailable markers expire after one hour. Do not remove or
  // renew them: the client owns fallback and recovery.
  try {
    const file = path.join(root, "cache", "antigravity-keyring-unavailable");
    safePath(file);
    const stat = fs.statSync(file);
    return stat.isFile() && now - stat.mtimeMs < 3600000;
  } catch { return false; }
}
function parseStoredToken(data, now = Date.now()) {
  if (!object(data)) return { invalid: true };
  const t = Object.hasOwn(data, "token") ? data.token : data;
  if (t === null) return { account: null };
  if (!object(t) || ["access_token", "refresh_token", "expiry"].some((k) => t[k] != null && typeof t[k] !== "string"))
    return { invalid: true };
  if (!has(t.access_token) && !has(t.refresh_token)) return { account: null };
  const secrets = [t.access_token, t.refresh_token, data.id_token];
  const expiry = has(t.expiry) ? Date.parse(t.expiry) : NaN;
  if (has(t.expiry) && !Number.isFinite(expiry)) return { invalid: true };
  const auth = authorization(t.access_token, t.refresh_token, expiry > 0 ? expiry / 1000 : null, now);
  const rawIdentity = claims(data.id_token);
  // Claims are local display metadata, not network-verified identity. Require
  // the documented Google issuer; never reinterpret arbitrary JWT claims.
  const identity = ["https://accounts.google.com", "accounts.google.com"].includes(rawIdentity.iss) ? rawIdentity : {};
  const fields = [["email", "邮箱", identity.email], ["name", "名称", identity.name],
    ["accountId", "用户 ID", identity.sub], ["organization", "组织域名", identity.hd],
    ["plan", "套餐", data.tier_display_name || data.user_tier],
    ["projectId", "Google Cloud 项目", data.project_id], ["region", "区域", data.region],
    ["authMethod", "授权方式", data.auth_method], ["wifProvider", "身份联邦", data.wif_provider]]
    .flatMap(([id, label, value]) => { const safe = text(value, secrets); return safe ? [{ id, label, value: safe }] : []; });
  const identityKey = has(identity.sub) ? digest(identity.iss + "\0" + identity.sub) : "";
  return { grant: data, account: { ...auth, refreshable: has(t.refresh_token),
    identityKey,
    quotaAccount: identityKey || (has(t.refresh_token) ? digest(t.refresh_token) : ""),
    profile: { source: "local", docs: ["antigravity"], fields } } };
}

// Fixed native target only: no CredEnumerate and no arbitrary target from IPC.
// Raw payloads stay in the main process and are used only by encrypted OAuth
// history; renderer state receives presentation metadata only.
const KEYRING_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace ASS {
  public static class AntigravityCredential {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
      public uint Flags, Type;
      public IntPtr TargetName, Comment;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
      public uint CredentialBlobSize;
      public IntPtr CredentialBlob;
      public uint Persist, AttributeCount;
      public IntPtr Attributes, TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll")] private static extern void CredFree(IntPtr credential);
    public static string Read() {
      IntPtr ptr;
      if (!CredRead("gemini:antigravity", 1, 0, out ptr)) {
        if (Marshal.GetLastWin32Error() == 1168) return null;
        throw new InvalidOperationException();
      }
      try {
        Credential c = (Credential)Marshal.PtrToStructure(ptr, typeof(Credential));
        if (c.CredentialBlobSize > 65536 || (c.CredentialBlobSize > 0 && c.CredentialBlob == IntPtr.Zero))
          throw new InvalidOperationException();
        byte[] bytes = new byte[c.CredentialBlobSize];
        try {
          Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);
          return new UTF8Encoding(false, true).GetString(bytes);
        } finally { Array.Clear(bytes, 0, bytes.Length); }
      } finally { CredFree(ptr); }
    }
  }
}
'@
  $credentialValue = [ASS.AntigravityCredential]::Read()
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  if ($null -eq $credentialValue) { [Console]::Write('{"status":"missing"}') }
  else { [Console]::Write((@{status='detected';payload=$credentialValue} | ConvertTo-Json -Compress)) }
} catch { [Console]::Write('{"status":"unreadable"}') }
`;
const KEYRING_WRITE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
namespace ASS {
  public static class AntigravityCredentialWrite {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
      public uint Flags, Type;
      [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
      [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
      public uint CredentialBlobSize;
      public IntPtr CredentialBlob;
      public uint Persist, AttributeCount;
      public IntPtr Attributes;
      [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
      [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
    }
    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref Credential credential, uint flags);
    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, uint type, uint flags);
    public static void Apply(string action, string value) {
      if (action == "delete") {
        if (!CredDelete("gemini:antigravity", 1, 0)) {
          int error = Marshal.GetLastWin32Error();
          if (error != 1168) throw new Win32Exception(error);
        }
        return;
      }
      if (action != "write") throw new InvalidOperationException();
      byte[] bytes = new UTF8Encoding(false, true).GetBytes(value);
      if (bytes.Length == 0 || bytes.Length > 2560) throw new InvalidOperationException();
      IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
      try {
        Marshal.Copy(bytes, 0, blob, bytes.Length);
        Credential c = new Credential { Type = 1, TargetName = "gemini:antigravity",
          CredentialBlobSize = (uint)bytes.Length, CredentialBlob = blob,
          Persist = 2, UserName = "antigravity" };
        if (!CredWrite(ref c, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
      } finally {
        for (int i = 0; i < bytes.Length; i++) Marshal.WriteByte(blob, i, 0);
        Array.Clear(bytes, 0, bytes.Length);
        Marshal.FreeHGlobal(blob);
      }
    }
  }
}
'@
  $inputValue = [Console]::In.ReadToEnd()
  $separator = $inputValue.IndexOf([char]10)
  if ($separator -lt 0) { throw 'invalid input' }
  $action = $inputValue.Substring(0, $separator).TrimEnd([char]13)
  $payload = $inputValue.Substring($separator + 1)
  [ASS.AntigravityCredentialWrite]::Apply($action, $payload)
  [Console]::Write('{"status":"ok"}')
} catch { [Console]::Write('{"status":"unreadable"}') }
`;
function rawResult(output) {
  const result = JSON.parse(String(output).replace(/^\uFEFF/, ""));
  if (result.status === "missing") return null;
  if (result.status !== "detected" || typeof result.payload !== "string" || result.payload.length > 65536) throw Error();
  return result.payload;
}
function readKeyringRawSync({ platform = process.platform, run = execFileSync } = {}) {
  if (platform !== "win32") throw Error("Antigravity 系统凭据仅支持 Windows");
  try {
    return rawResult(run(powershell(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(KEYRING_SCRIPT)],
      { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024, encoding: "utf8" }));
  } catch { throw Error("Antigravity 系统凭据无法读取"); }
}
function writeKeyringRawSync(value, { platform = process.platform, run = spawnSync } = {}) {
  if (platform !== "win32") throw Error("Antigravity 系统凭据仅支持 Windows");
  if (value !== null && (typeof value !== "string" || !value || Buffer.byteLength(value) > 2560))
    throw Error("Antigravity 系统凭据超过原生容量限制");
  try {
    const result = run(powershell(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(KEYRING_WRITE_SCRIPT)],
      { input: (value === null ? "delete" : "write") + "\n" + (value || ""), windowsHide: true,
        timeout: 5000, maxBuffer: 256 * 1024, encoding: "utf8" });
    if (result.error || result.status !== 0 || JSON.parse(String(result.stdout).replace(/^\uFEFF/, "")).status !== "ok") throw Error();
  } catch { throw Error("Antigravity 系统凭据无法写入"); }
}
const keyringAdapter = { read: () => readKeyringRawSync(), write: (value) => writeKeyringRawSync(value) };
async function readKeyring({ platform = process.platform, run = execFile, now = Date.now(), includeGrant = false } = {}) {
  const base = { file: KEYRING_SOURCE, checkedAt: now };
  if (platform !== "win32") return { ...base, status: "external", message: "此系统密钥库暂未适配" };
  return new Promise((resolve) => {
    const failure = () => resolve({ ...base, status: "unreadable", message: "Antigravity 系统凭据无法读取" });
    try {
      run(powershell(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(KEYRING_SCRIPT)],
        { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024, encoding: "utf8" }, (err, output) => {
          if (err) return failure();
          try {
            const raw = rawResult(output);
            if (raw === null) return resolve({ ...base, status: "missing", ...(includeGrant ? { raw: null } : {}) });
            const parsed = parseStoredToken(JSON.parse(raw), now);
            if (parsed.invalid) return failure();
            resolve({ ...base, status: "detected", account: parsed.account,
              ...(includeGrant ? { raw, grant: parsed.grant } : {}) });
          } catch { failure(); }
        });
    } catch { failure(); }
  });
}
function historyFile(source) {
  return source.storage === "keyring" ? path.join(source.root, ".ass-keyring-gemini-antigravity") : path.join(source.root, TOKEN_FILE);
}
function historySources(options) {
  const root = credentialRoot(options), now = options.now || Date.now(), fallback = path.join(root, TOKEN_FILE);
  let storage = "";
  if (filePreferred(root, now)) storage = "file";
  else if (options.keyring?.status === "detected" && typeof options.keyring.raw === "string") storage = "keyring";
  else if (options.keyring?.status === "missing" && fs.existsSync(fallback)) storage = "file";
  else if (options.keyring?.status === "missing") storage = "keyring";
  else if (options.keyring?.status && options.keyring.status !== "detected" && fs.existsSync(fallback)) storage = "file";
  else if (!options.keyring && fs.existsSync(fallback)) storage = "file";
  else if (options.override && fs.existsSync(fallback)) storage = "file";
  if (!storage) return [];
  return [{ harness: "antigravity", dir: root, root, storage, native: true,
    keyring: options.keyring, keyringAdapter: options.keyringAdapter || options.keyring?.adapter || keyringAdapter }];
}
function shouldReadKeyring(options) {
  // Test/custom homes must never silently read the host OS account.
  if (!same(options.home, os.homedir()) || !same(credentialRoot(options), path.join(os.homedir(), ".gemini"))) return false;
  return !!(options.launcher?.ready || options.launcher?.installed ||
    locations(options).some(({ dir }) => directorySource(dir).status === "detected") ||
    fs.existsSync(path.join(credentialRoot(options), TOKEN_FILE)));
}
function inspect(options, read, makeAccount) {
  const { env = {}, launcher, now = Date.now(), keyring } = options;
  const sources = [], accounts = [], surfaces = [], roots = locations(options);
  let cliApiMode = false, cliQuotaAllowed = false;
  for (const { dir, variant } of roots) {
    const directory = directorySource(dir);
    if (variant === "cli" || variant === "custom") {
      const config = read(path.join(dir, "settings.json")); sources.push(config);
      cliQuotaAllowed = config.status === "missing" || config.status === "detected" && !config.data?.modelProvider;
      if (config.status !== "missing" || directory.status === "detected") surfaces.push(variant);
      if (config.data?.modelProvider === "gemini") {
        cliApiMode = true;
        let official = !env.GOOGLE_GEMINI_BASE_URL;
        if (!official) try { const u = new URL(env.GOOGLE_GEMINI_BASE_URL);
          official = u.protocol === "https:" && u.hostname === "generativelanguage.googleapis.com" && !u.port && !u.username && !u.password && !u.search && !u.hash;
        } catch {}
        if (has(env.GEMINI_API_KEY) && official) accounts.push(makeAccount("antigravity", dir, "环境变量 GEMINI_API_KEY", "gemini", "Gemini API",
          { authType: "api", ready: true, status: "detected", message: "API Key" }, [["keyEnvironment", "密钥变量", "GEMINI_API_KEY"]]));
      }
    } else sources.push(directory);
    if (directory.status === "detected" && !surfaces.includes(variant)) surfaces.push(variant);
  }
  if (launcher?.installed && labels[launcher.nativeVariant] && !surfaces.includes(launcher.nativeVariant)) surfaces.push(launcher.nativeVariant);
  const root = credentialRoot(options), fallback = read(path.join(root, TOKEN_FILE));
  sources.push(fallback);
  const native = fallback.data ? parseStoredToken(fallback.data, now) : {};
  if (native.invalid) { fallback.status = "unreadable"; fallback.message = "Antigravity 凭据格式无法识别"; }
  const source = keyring && same(root, path.join(options.home, ".gemini")) ? keyring : null;
  if (source) sources.push({ file: source.file, status: source.status, message: source.message || "" });
  else if (surfaces.length && !cliApiMode) sources.push({ file: KEYRING_SOURCE, status: "external", message: "刷新客户端以读取系统凭据" });
  const preferFile = filePreferred(root, now);
  const selected = !preferFile && source?.status === "detected" ? source :
    native.account ? { ...fallback, account: native.account } : null;
  const oauthSurfaces = surfaces.filter((v) => !cliApiMode || !["cli", "custom"].includes(v));
  if (selected?.account && (!cliApiMode || oauthSurfaces.length)) {
    const a = selected.account;
    const expired = a.expiresAt !== null && a.expiresAt <= now && a.status !== "incomplete";
    const current = expired ? { ...a, ready: a.refreshable, status: a.refreshable ? "refresh-required" : "expired",
      message: a.refreshable ? "访问令牌已到期 · 由客户端刷新" : "授权已到期 · 需要重新登录" } : a;
    const value = makeAccount("antigravity", root, selected.file, "google-antigravity", "Gemini", current);
    value.id = "native:" + digest(["antigravity", root, a.quotaAccount || "native-login"].join("\0"));
    delete value.identityKey;
    delete value.refreshable;
    if (cliQuotaAllowed && a.quotaAccount) value.quotaAvailable = true;
    value.profile = { ...a.profile, fields: [...a.profile.fields,
      { id: "credentialStorage", label: "存储", value: selected === source ? "Windows 凭据管理器" : "原生凭据文件" },
      ...(oauthSurfaces.length ? [{ id: "clientSurface", label: "客户端", value: [...new Set(oauthSurfaces.map((v) => labels[v]).filter(Boolean))].join(" / ") }] : [])] };
    value.oauthHistorySource = historyFile({ root, storage: selected === source ? "keyring" : "file" });
    accounts.push(value);
  }
  return { sources, accounts, modelAccounts: [] };
}
module.exports = { locations, inspect, parseStoredToken, readKeyring, readKeyringRawSync, writeKeyringRawSync,
  shouldReadKeyring, historySources, historyFile, keyringAdapter, KEYRING_SOURCE };
