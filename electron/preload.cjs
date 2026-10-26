const { contextBridge, ipcRenderer } = require("electron");
const allowed = [
  "window-action",
  "snapshot",
  "request-monitor",
  "ui-preferences",
  "usage-refresh",
  "supplier-refresh",
  "client-model",
  "client-injection",
  "client-native-variant",
  "client-model-launch",
  "client-accountless-launch",
  "claude-desktop-copy",
  "client-credentials",
  "import",
  "save-provider",
  "delete-provider",
  "save-model",
  "delete-model",
  "account-bind-api",
  "account-save-api",
  "model-defaults",
  "connection-preview",
  "connection-apply",
  "connections-refresh",
  "app-exit-preview",
  "app-exit-direct",
  "connection-repair-preview",
  "connection-repair",
  "codex-prediction-repair",
  "diagnose",
  "diagnose-all",
  "diagnose-cancel",
  "models-discover",
  "capabilities-probe",
  "capabilities-cancel",
  "model-add-discovered",
  "balance",
  "autostart",
  "open-data",
  "export",
  "account-add",
  "account-select",
  "oauth-switch-preview",
  "oauth-switch-apply",
  "conversations-list",
  "conversations-backups",
  "conversations-backup-preview",
  "conversations-backup-cleanup",
  "conversations-backup-restore",
  "project-conversations-list",
  "project-conversations-trash-purge",
  "project-conversations-search",
  "project-conversations-delete",
  "project-conversations-trash",
  "project-conversations-restore",
  "project-conversations-configure",
  "project-conversations-sync",
  "project-conversations-threads",
  "project-conversations-records",
  "project-conversations-native-preview",
  "project-conversations-native-resume",
  "project-conversations-preview",
  "project-conversations-resume",
  "conversations-preview",
  "conversations-pin",
  "conversations-preserve",
  "conversations-resume",
  "conversations-open-desktop",
  "conversations-location",
  "conversation-open-link",
  "native-login-preview",
  "native-login-apply",
  "account-info",
  "account-info-doc",
  "client-refresh",
  "client-executable",
  "client-detect",
  "client-open-desktop",
  "client-location",
  "client-workspace",
  "client-launch",
  "pi-import-oauth",
  "official-open",
  "native-key-save",
  "native-key-remove",
  "native-key-copy",
  "openrouter-auth-start",
  "openrouter-auth-cancel",
  "update-check",
  "update-preferences",
  "update-dismiss",
  "update-open",
];
contextBridge.exposeInMainWorld("ass", {
  windowChrome: process.platform === "win32",
  onWindowState: (callback) => {
    const handler = (_, value) => callback(value);
    ipcRenderer.on("ass:window-state", handler);
    return () => ipcRenderer.removeListener("ass:window-state", handler);
  },
  onManage: (callback) => {
    const handler = (_, value) => callback(value);
    ipcRenderer.on("ass:manage", handler);
    return () => ipcRenderer.removeListener("ass:manage", handler);
  },
  call: (name, ...args) => {
    if (!allowed.includes(name)) throw new Error("Unsupported action");
    return ipcRenderer.invoke("ass:" + name, ...args);
  },
  subscribe: (callback) => {
    const handler = (_, value) => callback(value);
    ipcRenderer.on("ass:state", handler);
    return () => ipcRenderer.removeListener("ass:state", handler);
  },
  onStateError: (callback) => {
    const handler = (_, message) => callback(message);
    ipcRenderer.on("ass:state-error", handler);
    return () => ipcRenderer.removeListener("ass:state-error", handler);
  },
});
