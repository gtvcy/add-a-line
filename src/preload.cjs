const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sideNote", {
  loadNotebook: () => ipcRenderer.invoke("notebook:load"),
  saveNotebook: (notebook) => ipcRenderer.invoke("notebook:save", notebook),
  exportMarkdown: (payload) => ipcRenderer.invoke("export:markdown", payload),
  exportDocx: (payload) => ipcRenderer.invoke("export:docx", payload),
  print: (payload) => ipcRenderer.invoke("print:notebook", payload),
  hideWindow: () => ipcRenderer.invoke("window:hide"),
  setAutoHide: (enabled) => ipcRenderer.invoke("window:set-auto-hide", enabled),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke("window:set-always-on-top", enabled),
  getLoginItem: () => ipcRenderer.invoke("app:get-login-item"),
  setLoginItem: (enabled) => ipcRenderer.invoke("app:set-login-item", enabled),
  openFiles: () => ipcRenderer.invoke("file:open"),
  pickImage: () => ipcRenderer.invoke("image:pick"),
  prepareImage: (payload) => ipcRenderer.invoke("image:prepare", payload),
  prepareImageUrl: (value) => ipcRenderer.invoke("image:prepare-url", value),
  savePane: (payload) => ipcRenderer.invoke("file:save-pane", payload),
  confirmRemovePane: (payload) => ipcRenderer.invoke("pane:confirm-remove", payload),
  showInFolder: (filePath) => ipcRenderer.invoke("file:reveal", filePath),
  getShortcutStatus: () => ipcRenderer.invoke("shortcut:get-status"),
  restartShortcut: () => ipcRenderer.invoke("shortcut:restart"),
  onNewPane: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("command:new-pane", listener);
    return () => ipcRenderer.removeListener("command:new-pane", listener);
  },
  onShortcutStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("shortcut:status", listener);
    return () => ipcRenderer.removeListener("shortcut:status", listener);
  }
});
