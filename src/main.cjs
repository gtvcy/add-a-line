const { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { fileURLToPath } = require("node:url");
const { promisify } = require("node:util");
const { exportMarkdown, exportDocx, buildPrintHtml, safeName, savePaneToFile } = require("./services/exporter.cjs");
const { importFile } = require("./services/importer.cjs");

const APP_NAME = "添一笔";
const LEGACY_USER_DATA_NAME = "sidenote-mac";
const PRIMARY_HOTKEY = "Control+Alt+Z";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["heic", "image/heic"],
  ["heif", "image/heif"]
]);
const IMAGE_EXTENSIONS_BY_MIME = new Map([...IMAGE_MIME_TYPES.entries()].map(([extension, mimeType]) => [mimeType, extension]));
const HEIC_EXTENSIONS = new Set(["heic", "heif"]);
const execFileAsync = promisify(execFile);
if (process.env.SIDENOTE_TEST_USER_DATA) app.setPath("userData", process.env.SIDENOTE_TEST_USER_DATA);
else app.setPath("userData", path.join(app.getPath("appData"), LEGACY_USER_DATA_NAME));
let mainWindow = null;
let tray = null;
let shortcutStatus = "starting";
let autoHide = false;
let isQuitting = false;

function imageExtension(name) {
  return path.extname(String(name || "")).slice(1).toLowerCase();
}

function assertSupportedImage(name) {
  const extension = imageExtension(name);
  if (!IMAGE_MIME_TYPES.has(extension)) throw new Error("暂不支持这种图片格式");
  return extension;
}

function dataUrlForImage(buffer, mimeType) {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

async function convertHeicToPng(buffer, extension) {
  if (process.platform !== "darwin") throw new Error("HEIC 图片仅支持在 macOS 中转换");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sidenote-image-"));
  const input = path.join(directory, `image.${extension}`);
  const output = path.join(directory, "image.png");
  try {
    await fs.writeFile(input, buffer);
    await execFileAsync("/usr/bin/sips", ["-s", "format", "png", input, "--out", output]);
    return dataUrlForImage(await fs.readFile(output), "image/png");
  } catch (error) {
    console.error("Unable to convert HEIC image", error);
    throw new Error("无法转换这张 HEIC 图片");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function prepareImage({ name, type, bytes }) {
  const extension = assertSupportedImage(name);
  const buffer = Buffer.from(bytes || []);
  if (buffer.length === 0) throw new Error("未读取到图片内容");
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("图片不能超过 25 MB");
  const source = HEIC_EXTENSIONS.has(extension)
    ? await convertHeicToPng(buffer, extension)
    : dataUrlForImage(buffer, IMAGE_MIME_TYPES.get(extension));
  return { ok: true, name: path.basename(String(name || "图片")), source, type: String(type || IMAGE_MIME_TYPES.get(extension)) };
}

async function prepareImagePath(filePath) {
  const resolvedPath = path.resolve(String(filePath || ""));
  const image = await prepareImage({ name: path.basename(resolvedPath), bytes: await fs.readFile(resolvedPath) });
  return { ...image, path: resolvedPath };
}

function imagePathFromFileUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "file:") throw new Error("只能读取本机图片文件");
  return fileURLToPath(url);
}

async function prepareRemoteImage(value) {
  const url = new URL(String(value || ""));
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("只能读取网页图片地址");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Add a Line/1.6" },
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`图片下载失败（${response.status}）`);
    const mimeType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    const extension = IMAGE_EXTENSIONS_BY_MIME.get(mimeType);
    if (!extension) throw new Error("网页没有提供可插入的图片文件");
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_IMAGE_BYTES) throw new Error("图片不能超过 25 MB");
    const bytes = new Uint8Array(await response.arrayBuffer());
    return prepareImage({ name: `网页图片.${extension}`, type: mimeType, bytes });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("图片下载超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function prepareImageUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol === "file:") return prepareImagePath(imagePathFromFileUrl(url.href));
  return prepareRemoteImage(url.href);
}

function notebookPath() {
  return path.join(app.getPath("userData"), "notebook.json");
}

function defaultNotebook() {
  const now = new Date().toISOString();
  return {
    version: 1,
    title: "我的添一笔",
    layout: { mode: "vertical", columns: 2 },
    pinnedPaneId: null,
    maximizedPaneId: null,
    preferences: { autoHide: false, alwaysOnTop: false, fontSize: 16 },
    panes: [
      {
        id: crypto.randomUUID(),
        title: "随手记",
        html: "<p><br></p>",
        color: "none",
        frame: { x: 28, y: 28, width: 430, height: 360 },
        createdAt: now,
        updatedAt: now
      }
    ]
  };
}

async function loadNotebook() {
  try {
    const raw = await fs.readFile(notebookPath(), "utf8");
    const parsed = JSON.parse(raw);
    autoHide = Boolean(parsed.preferences?.autoHide);
    return parsed;
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Failed to load notebook", error);
    return defaultNotebook();
  }
}

async function saveNotebook(notebook) {
  const target = notebookPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(notebook, null, 2), "utf8");
  await fs.rename(temporary, target);
  autoHide = Boolean(notebook.preferences?.autoHide);
  return { ok: true };
}

function positionWindow({ initial = false } = {}) {
  if (!mainWindow) return;
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const area = display.workArea;
  const current = mainWindow.getBounds();
  const width = initial
    ? Math.min(1120, Math.max(360, area.width - 48))
    : Math.min(area.width - 24, Math.max(360, current.width));
  const height = initial
    ? Math.min(860, area.height - 24)
    : Math.min(area.height - 24, Math.max(420, current.height));
  mainWindow.setBounds({
    x: area.x + area.width - width - 12,
    y: area.y + 12,
    width,
    height
  }, false);
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
    return;
  }
  positionWindow();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 360,
    minHeight: 420,
    show: false,
    title: APP_NAME,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#f4f4f1",
    movable: true,
    resizable: true,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("blur", () => {
    if (autoHide && mainWindow?.isVisible()) mainWindow.hide();
  });
  mainWindow.once("ready-to-show", () => {
    positionWindow({ initial: true });
    mainWindow.show();
  });
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setToolTip(`${APP_NAME} · 同时按 ⌃⌥Z`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示或隐藏添一笔（⌃⌥Z）", click: toggleWindow },
    { label: "新建分栏", accelerator: "CmdOrCtrl+N", click: () => {
      if (!mainWindow?.isVisible()) toggleWindow();
      mainWindow?.webContents.send("command:new-pane");
    } },
    { type: "separator" },
    { label: "退出添一笔", role: "quit" }
  ]));
}

function createTray() {
  const iconPath = path.join(__dirname, "..", "assets", "trayTemplate.png");
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  updateTrayMenu();
  tray.on("click", toggleWindow);
}

function emitShortcutStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("shortcut:status", shortcutStatus);
  }
}

function setShortcutStatus(status) {
  shortcutStatus = status;
  emitShortcutStatus();
}

function registerPrimaryShortcut() {
  globalShortcut.unregister(PRIMARY_HOTKEY);
  const registered = globalShortcut.register(PRIMARY_HOTKEY, toggleWindow);
  setShortcutStatus(registered ? "ready" : "unavailable");
  return registered;
}

async function createPrintWindow(payload) {
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true }
  });
  const html = buildPrintHtml(payload);
  await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return new Promise((resolve) => {
    printWindow.webContents.print({ printBackground: true }, (success, failureReason) => {
      printWindow.destroy();
      resolve(success ? { ok: true } : { ok: false, error: failureReason || "打印已取消" });
    });
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function sameFile(leftPath, rightPath) {
  try {
    const [left, right] = await Promise.all([fs.stat(leftPath), fs.stat(rightPath)]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function pathForPaneTitle(filePath, title) {
  const extension = path.extname(filePath);
  const fallback = path.basename(filePath, extension) || APP_NAME;
  let baseName = safeName(title, fallback);
  if (extension && baseName.toLowerCase().endsWith(extension.toLowerCase())) {
    baseName = safeName(baseName.slice(0, -extension.length), fallback);
  }
  return {
    filePath: path.join(path.dirname(filePath), `${baseName}${extension}`),
    title: baseName
  };
}

async function renameAndSavePane(pane, sourcePath, destinationPath) {
  const destinationExists = await fileExists(destinationPath);
  const destinationIsSource = destinationExists && await sameFile(sourcePath, destinationPath);
  if (destinationExists && !destinationIsSource) {
    const result = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "同名文件已存在",
      message: `“${path.basename(destinationPath)}”已经存在，是否覆盖？`,
      detail: "覆盖后无法撤销。原分栏文件会在保存成功后改为这个名称。",
      buttons: ["覆盖并保存", "取消"],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    });
    if (result.response !== 0) return { canceled: true };
  }

  const sourceExists = await fileExists(sourcePath);
  const backupPath = destinationExists && !destinationIsSource
    ? `${destinationPath}.add-a-line-backup-${crypto.randomUUID()}`
    : null;
  let sourceMoved = false;
  try {
    if (backupPath) await fs.rename(destinationPath, backupPath);
    if (sourceExists) {
      await fs.rename(sourcePath, destinationPath);
      sourceMoved = true;
    }
    const saved = await savePaneToFile(pane, destinationPath);
    if (backupPath) await fs.unlink(backupPath);
    return { ok: true, filePath: destinationPath, renamed: sourcePath !== destinationPath, ...saved };
  } catch (error) {
    if (sourceMoved) await fs.rename(destinationPath, sourcePath).catch(() => {});
    if (backupPath) await fs.rename(backupPath, destinationPath).catch(() => {});
    throw error;
  }
}

function registerIpc() {
  ipcMain.handle("notebook:load", loadNotebook);
  ipcMain.handle("notebook:save", (_event, notebook) => saveNotebook(notebook));
  ipcMain.handle("window:hide", () => mainWindow?.hide());
  ipcMain.handle("window:set-auto-hide", (_event, enabled) => { autoHide = Boolean(enabled); });
  ipcMain.handle("window:set-always-on-top", (_event, enabled) => {
    mainWindow?.setAlwaysOnTop(Boolean(enabled), "floating");
    return mainWindow?.isAlwaysOnTop() || false;
  });
  ipcMain.handle("app:get-login-item", () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle("app:set-login-item", (_event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true });
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle("shortcut:get-status", () => shortcutStatus);
  ipcMain.handle("shortcut:restart", () => {
    setShortcutStatus("starting");
    return { ok: registerPrimaryShortcut() };
  });
  ipcMain.handle("file:reveal", (_event, filePath) => shell.showItemInFolder(filePath));
  ipcMain.handle("file:open", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "打开文件为新分栏",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "支持的文件", extensions: ["md", "markdown", "txt", "text", "html", "htm", "docx", "png", "jpg", "jpeg", "gif", "webp"] },
        { name: "Markdown", extensions: ["md", "markdown"] },
        { name: "Word 文档", extensions: ["docx"] },
        { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const panes = [];
    const errors = [];
    for (const filePath of result.filePaths) {
      try {
        panes.push(await importFile(filePath));
      } catch (error) {
        errors.push(`${path.basename(filePath)}：${error.message}`);
      }
    }
    return { ok: panes.length > 0, panes, errors };
  });
  ipcMain.handle("image:pick", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "插入图片",
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: [...IMAGE_MIME_TYPES.keys()] }]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return prepareImagePath(result.filePaths[0]);
  });
  ipcMain.handle("image:prepare", (_event, payload) => prepareImage(payload || {}));
  ipcMain.handle("image:prepare-url", (_event, value) => prepareImageUrl(value));
  ipcMain.handle("file:save-pane", async (_event, payload) => {
    const supportedExtensions = new Set([".md", ".markdown", ".txt", ".text", ".html", ".htm", ".docx"]);
    let filePath = payload.targetPath ? String(payload.targetPath) : null;
    if (!filePath || !supportedExtensions.has(path.extname(filePath).toLowerCase())) {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: "保存分栏",
        defaultPath: `${payload.suggestedName || APP_NAME}.md`,
        filters: [
          { name: "Markdown", extensions: ["md"] },
          { name: "Word 文档", extensions: ["docx"] },
          { name: "纯文本", extensions: ["txt"] },
          { name: "HTML", extensions: ["html"] }
        ]
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      filePath = result.filePath;
    }
    if (payload.targetPath) {
      const titled = pathForPaneTitle(filePath, payload.pane?.title);
      if (titled.filePath !== filePath) {
        const result = await renameAndSavePane(payload.pane, filePath, titled.filePath);
        return result.canceled ? result : { ...result, savedTitle: titled.title };
      }
    }
    const saved = await savePaneToFile(payload.pane, filePath);
    return { ok: true, filePath, ...saved };
  });
  ipcMain.handle("pane:confirm-remove", async (_event, payload) => {
    const result = await dialog.showMessageBox(mainWindow, {
      type: "question",
      title: "移除分栏",
      message: `从添一笔中移除“${payload.title || "未命名分栏"}”？`,
      detail: payload.hasTarget
        ? "只会移除界面中的分栏，不会删除源文件。是否先保存当前修改？"
        : "此分栏尚未保存为文件。是否先另存？移除不会删除任何文件。",
      buttons: ["保存并移除", "不保存，直接移除", "取消"],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    return ["save", "discard", "cancel"][result.response] || "cancel";
  });
  ipcMain.handle("print:notebook", (_event, payload) => createPrintWindow(payload));
  ipcMain.handle("export:markdown", async (_event, payload) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出 Markdown",
      defaultPath: `${payload.suggestedName || APP_NAME}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await exportMarkdown(payload, result.filePath);
    return { ok: true, filePath: result.filePath };
  });
  ipcMain.handle("export:docx", async (_event, payload) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出 Word 文档",
      defaultPath: `${payload.suggestedName || APP_NAME}.docx`,
      filters: [{ name: "Word 文档", extensions: ["docx"] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await exportDocx(payload, result.filePath);
    return { ok: true, filePath: result.filePath };
  });
}

app.whenReady().then(() => {
  app.setName(APP_NAME);
  if (process.platform === "darwin") app.dock.hide();
  registerIpc();
  createWindow();
  createTray();
  registerPrimaryShortcut();
});

app.on("before-quit", () => { isQuitting = true; });
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
app.on("window-all-closed", () => {});
