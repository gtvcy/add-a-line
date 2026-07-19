const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const elements = {
  workspace: $("#workspace"),
  notebookTitle: $("#notebook-title"),
  saveState: $("#save-state"),
  layoutControl: $("#layout-control"),
  columnStepper: $("#column-stepper"),
  columnCount: $("#column-count"),
  sortButton: $("#sort-button"),
  sortMenu: $("#sort-menu"),
  alwaysOnTop: $("#always-on-top-button"),
  insertImage: $("#insert-image"),
  settingsDialog: $("#settings-dialog"),
  autoHide: $("#auto-hide-setting"),
  loginItem: $("#login-item-setting"),
  shortcutStatus: $("#shortcut-status"),
  shortcutRestart: $("#shortcut-restart"),
  fontSize: $("#font-size-setting"),
  fontSizeLabel: $("#font-size-label"),
  toast: $("#toast"),
  toastMessage: $("#toast-message"),
  toastAction: $("#toast-action"),
  paneTemplate: $("#pane-template")
};

let notebook = null;
let activePaneId = null;
let selectedImage = null;
let savedRange = null;
let saveTimer = null;
let toastTimer = null;
let lastExportPath = null;
const MIN_PANE_WIDTH = 220;
const MIN_PANE_HEIGHT = 200;
const PANE_COLORS = new Set(["none", "red", "orange", "yellow", "green", "blue", "indigo", "purple"]);
const SUPPORTED_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"]);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function createId() {
  return crypto.randomUUID();
}

function fileFormatFromPath(filePath) {
  const extension = String(filePath || "").toLowerCase().match(/\.[^.\\/]+$/)?.[0] || "";
  if ([".md", ".markdown"].includes(extension)) return "markdown";
  if ([".txt", ".text"].includes(extension)) return "text";
  if ([".html", ".htm"].includes(extension)) return "html";
  if (extension === ".docx") return "docx";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension)) return "image";
  return null;
}

function normalizeFileRecord(value, dateField) {
  if (!value || typeof value !== "object" || !value.path) return null;
  return {
    path: String(value.path),
    type: String(value.type || "文件"),
    format: value.format ? String(value.format) : fileFormatFromPath(value.path),
    scope: value.scope ? String(value.scope) : null,
    [dateField]: String(value[dateField] || new Date().toISOString())
  };
}

function optionalSize(value, minimum) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(minimum, number) : null;
}

function normalizeNotebook(value) {
  const now = new Date().toISOString();
  const result = value && typeof value === "object" ? value : {};
  result.version = 1;
  result.title = String(result.title || "我的添一笔");
  result.layout = {
    mode: ["horizontal", "vertical", "grid", "free"].includes(result.layout?.mode) ? result.layout.mode : "vertical",
    columns: Math.min(4, Math.max(1, Number(result.layout?.columns) || 2))
  };
  result.preferences = {
    autoHide: Boolean(result.preferences?.autoHide),
    alwaysOnTop: Boolean(result.preferences?.alwaysOnTop),
    fontSize: Math.min(24, Math.max(13, Number(result.preferences?.fontSize) || 16))
  };
  result.panes = Array.isArray(result.panes) ? result.panes : [];
  result.panes = result.panes.map((pane, index) => {
    const sourceFile = normalizeFileRecord(pane.sourceFile, "openedAt");
    const externalSave = normalizeFileRecord(pane.externalSave, "savedAt");
    let saveTarget = normalizeFileRecord(pane.saveTarget, "savedAt");
    if (!saveTarget && sourceFile && ["markdown", "text", "html", "docx"].includes(sourceFile.format)) {
      saveTarget = { ...sourceFile, savedAt: sourceFile.openedAt };
      delete saveTarget.openedAt;
    }
    if (!saveTarget && externalSave && ["markdown", "text", "html", "docx"].includes(externalSave.format)) {
      saveTarget = { ...externalSave };
    }
    return {
      id: String(pane.id || createId()),
      title: String(pane.title || `分栏 ${index + 1}`),
      html: String(pane.html || "<p><br></p>"),
      frame: {
        x: Math.max(0, Number(pane.frame?.x) || 28 + index * 26),
        y: Math.max(0, Number(pane.frame?.y) || 28 + index * 26),
        width: Math.max(MIN_PANE_WIDTH, Number(pane.frame?.width) || 430),
        height: Math.max(MIN_PANE_HEIGHT, Number(pane.frame?.height) || 360)
      },
      sizes: {
        horizontal: { width: optionalSize(pane.sizes?.horizontal?.width, MIN_PANE_WIDTH) },
        vertical: { height: optionalSize(pane.sizes?.vertical?.height, MIN_PANE_HEIGHT) },
        grid: {
          width: optionalSize(pane.sizes?.grid?.width, MIN_PANE_WIDTH),
          height: optionalSize(pane.sizes?.grid?.height, MIN_PANE_HEIGHT)
        }
      },
      sourceFile,
      externalSave,
      saveTarget,
      color: PANE_COLORS.has(pane.color) ? pane.color : "none",
      createdAt: pane.createdAt || now,
      updatedAt: pane.updatedAt || now
    };
  });
  if (result.panes.length === 0) {
    result.panes.push(newPane("随手记", 0));
  }
  const pinnedPaneId = result.pinnedPaneId ? String(result.pinnedPaneId) : null;
  result.pinnedPaneId = result.panes.some((pane) => pane.id === pinnedPaneId) ? pinnedPaneId : null;
  const maximizedPaneId = result.maximizedPaneId ? String(result.maximizedPaneId) : null;
  result.maximizedPaneId = result.panes.some((pane) => pane.id === maximizedPaneId) ? maximizedPaneId : null;
  return result;
}

function newPane(title, index = notebook?.panes.length || 0) {
  const now = new Date().toISOString();
  const offset = (index % 7) * 28;
  return {
    id: createId(),
    title: title || `分栏 ${index + 1}`,
    html: "<p><br></p>",
    frame: { x: 28 + offset, y: 28 + offset, width: 430, height: 360 },
    sizes: {
      horizontal: { width: null },
      vertical: { height: null },
      grid: { width: null, height: null }
    },
    sourceFile: null,
    externalSave: null,
    saveTarget: null,
    color: "none",
    createdAt: now,
    updatedAt: now
  };
}

function cleanEditorHtml(raw) {
  const template = document.createElement("template");
  template.innerHTML = raw || "";
  template.content.querySelectorAll("script, style, iframe, object, embed, link, meta").forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((node) => {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith("on") || (["href", "src"].includes(name) && /^(javascript|vbscript):/.test(value))) {
        node.removeAttribute(attribute.name);
      }
    }
  });
  return template.innerHTML;
}

function paneById(id) {
  return notebook.panes.find((pane) => pane.id === id);
}

function activeEditor() {
  return $(`.note-pane[data-id="${CSS.escape(activePaneId || "")}"] .editor`);
}

function setActivePane(id) {
  if (!paneById(id)) return;
  activePaneId = id;
  $$(".note-pane").forEach((pane) => pane.classList.toggle("active", pane.dataset.id === id));
}

function countText(editor) {
  return (editor.innerText || "").replace(/\s/g, "").length;
}

function paneFileRecord(pane) {
  return pane.saveTarget || pane.externalSave || pane.sourceFile || null;
}

function updatePaneMeta(paneElement, pane = paneById(paneElement.dataset.id)) {
  const editor = $(".editor", paneElement);
  $(".pane-meta", paneElement).textContent = `${countText(editor)} 字`;
  const revealAction = $(".reveal-file-action", paneElement);
  const saveButton = $(".pane-save-button", paneElement);
  const pinAction = $('[data-pane-action="pin"]', paneElement);
  const pinIndicator = $(".pane-pin-indicator", paneElement);
  const headerBlank = $(".pane-header-blank", paneElement);
  const record = paneFileRecord(pane);
  const hasWritableTarget = Boolean(pane.saveTarget?.path);
  const isPinned = notebook.pinnedPaneId === pane.id;
  const isMaximized = notebook.maximizedPaneId === pane.id;
  revealAction.hidden = !record;
  paneElement.dataset.paneColor = PANE_COLORS.has(pane.color) ? pane.color : "none";
  paneElement.classList.toggle("pinned", isPinned);
  paneElement.classList.toggle("maximized", isMaximized);
  pinIndicator.toggleAttribute("hidden", !isPinned);
  headerBlank.setAttribute("aria-label", isMaximized ? "双击还原分栏大小" : "双击最大化分栏");
  headerBlank.title = isMaximized ? "双击还原分栏大小" : "双击最大化分栏";
  pinAction.classList.toggle("active", isPinned);
  pinAction.setAttribute("aria-pressed", String(isPinned));
  $(".pane-pin-label", pinAction).textContent = isPinned ? "取消置顶" : "置顶此栏";
  $$("[data-pane-color]", paneElement).forEach((button) => {
    const selected = button.dataset.paneColor === paneElement.dataset.paneColor;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  saveButton.classList.toggle("needs-first-save", !hasWritableTarget);
  saveButton.title = hasWritableTarget ? `保存到 ${pane.saveTarget.path}` : "首次保存，需要选择文件位置";
}

function capturePane(paneElement) {
  const pane = paneById(paneElement.dataset.id);
  if (!pane) return;
  const editor = $(".editor", paneElement);
  const html = cleanEditorHtml(editor.innerHTML);
  if (html !== pane.html) {
    pane.html = html;
    pane.updatedAt = new Date().toISOString();
  }
  updatePaneMeta(paneElement);
}

function captureAllPanes() {
  $$(".note-pane", elements.workspace).forEach(capturePane);
}

function setSaveState(mode, message) {
  elements.saveState.classList.toggle("saving", mode === "saving");
  elements.saveState.classList.toggle("error", mode === "error");
  $("span:last-child", elements.saveState).textContent = message;
}

function scheduleSave() {
  setSaveState("saving", "保存中");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 450);
}

async function saveNow() {
  clearTimeout(saveTimer);
  captureAllPanes();
  try {
    await window.sideNote.saveNotebook(notebook);
    setSaveState("saved", "已保存");
  } catch (error) {
    console.error(error);
    setSaveState("error", "保存失败");
  }
}

function refreshIcons(root = document) {
  if (window.lucide) window.lucide.createIcons({ root, attrs: { "stroke-width": 1.8 } });
}

function updateLayoutControls() {
  $$('[data-layout]', elements.layoutControl).forEach((button) => {
    const active = button.dataset.layout === notebook.layout.mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
  elements.columnStepper.hidden = notebook.layout.mode !== "grid";
  elements.columnCount.textContent = `${notebook.layout.columns} 列`;
}

function updateFreeWorkspaceSize() {
  if (notebook.layout.mode !== "free" || notebook.maximizedPaneId) {
    elements.workspace.style.removeProperty("width");
    elements.workspace.style.removeProperty("height");
    return;
  }
  const width = Math.max(elements.workspace.clientWidth, ...notebook.panes.map((pane) => pane.frame.x + pane.frame.width + 60));
  const height = Math.max(elements.workspace.clientHeight, ...notebook.panes.map((pane) => pane.frame.y + pane.frame.height + 60));
  elements.workspace.style.width = `${width}px`;
  elements.workspace.style.height = `${height}px`;
}

function applyPaneFrame(element, pane) {
  for (const property of ["left", "top", "width", "height", "flex-basis"]) {
    element.style.removeProperty(property);
  }
  const resizeHandle = $(".resize-handle", element);
  const mode = notebook.layout.mode;
  const axis = mode === "horizontal" ? "x" : mode === "vertical" ? "y" : "both";
  element.dataset.resizeAxis = axis;
  resizeHandle.title = axis === "x" ? "拖动调整分栏宽度" : axis === "y" ? "拖动调整分栏高度" : "拖动调整分栏大小";

  if (mode === "free") {
    element.style.left = `${pane.frame.x}px`;
    element.style.top = `${pane.frame.y}px`;
    element.style.width = `${pane.frame.width}px`;
    element.style.height = `${pane.frame.height}px`;
  }
  if (mode === "horizontal" && pane.sizes.horizontal.width) {
    element.style.flexBasis = `${pane.sizes.horizontal.width}px`;
  }
  if (mode === "vertical" && pane.sizes.vertical.height) {
    element.style.flexBasis = `${pane.sizes.vertical.height}px`;
  }
  if (mode === "grid") {
    if (pane.sizes.grid.width) element.style.width = `${pane.sizes.grid.width}px`;
    if (pane.sizes.grid.height) element.style.height = `${pane.sizes.grid.height}px`;
  }
}

function closeMenus(except = null) {
  $$(".popup-menu").forEach((menu) => {
    if (menu !== except) menu.hidden = true;
  });
  if (except !== elements.sortMenu) elements.sortButton.setAttribute("aria-expanded", "false");
  $$(".pane-menu-button").forEach((button) => {
    if (button.closest(".menu-anchor")?.querySelector(".pane-menu") !== except) {
      button.setAttribute("aria-expanded", "false");
    }
  });
}

function togglePaneMaximize(id) {
  if (!paneById(id)) return;
  notebook.maximizedPaneId = notebook.maximizedPaneId === id ? null : id;
  activePaneId = id;
  renderWorkspace();
  scheduleSave();
}

function openPopup(menu, trigger, align = "right") {
  closeMenus(menu);
  menu.hidden = false;
  const triggerBounds = trigger.getBoundingClientRect();
  const menuBounds = menu.getBoundingClientRect();
  const below = triggerBounds.bottom + 6;
  const above = triggerBounds.top - menuBounds.height - 6;
  const openAbove = below + menuBounds.height > window.innerHeight - 8 && above >= 8;
  const preferredLeft = align === "left" ? triggerBounds.left : triggerBounds.right - menuBounds.width;
  const left = Math.min(window.innerWidth - menuBounds.width - 8, Math.max(8, preferredLeft));
  menu.classList.toggle("open-above", openAbove);
  menu.style.left = `${left}px`;
  menu.style.top = `${openAbove ? above : below}px`;
  trigger.setAttribute("aria-expanded", "true");
}

function renderWorkspace({ focusPane = null } = {}) {
  captureAllPanes();
  selectedImage = null;
  elements.workspace.className = `workspace layout-${notebook.layout.mode}`;
  elements.workspace.classList.toggle("has-maximized-pane", Boolean(notebook.maximizedPaneId));
  elements.workspace.style.setProperty("--grid-columns", notebook.layout.columns);
  elements.workspace.replaceChildren();

  for (const pane of notebook.panes) {
    const fragment = elements.paneTemplate.content.cloneNode(true);
    const paneElement = $(".note-pane", fragment);
    const title = $(".pane-title", paneElement);
    const editor = $(".editor", paneElement);
    paneElement.dataset.id = pane.id;
    title.value = pane.title;
    editor.innerHTML = cleanEditorHtml(pane.html);
    applyPaneFrame(paneElement, pane);
    bindPaneEvents(paneElement, pane);
    elements.workspace.append(paneElement);
    updatePaneMeta(paneElement);
  }

  if (!paneById(activePaneId)) activePaneId = notebook.panes[0]?.id || null;
  setActivePane(focusPane || activePaneId);
  updateLayoutControls();
  updateFreeWorkspaceSize();
  refreshIcons(elements.workspace);
  if (focusPane) {
    const editor = activeEditor();
    editor?.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function isSupportedImageFile(file) {
  if (!file) return false;
  if (/^image\/(png|jpe?g|gif|webp|heic|heif)$/i.test(file.type || "")) return true;
  const extension = String(file.name || "").split(".").pop()?.toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS.has(extension);
}

function imageFileFromDataTransfer(dataTransfer) {
  if (!dataTransfer) return null;
  const files = [...dataTransfer.files];
  for (const item of dataTransfer.items || []) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files.find(isSupportedImageFile) || null;
}

function usableImageUrl(value, { requireImageExtension = false } = {}) {
  try {
    const url = new URL(value);
    if (!["file:", "http:", "https:"].includes(url.protocol)) return null;
    const extension = decodeURIComponent(url.pathname).split(".").pop()?.toLowerCase();
    if (url.protocol === "file:" && !SUPPORTED_IMAGE_EXTENSIONS.has(extension)) return null;
    if (requireImageExtension && !SUPPORTED_IMAGE_EXTENSIONS.has(extension)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function imageUrlFromDataTransfer(dataTransfer) {
  const html = String(dataTransfer?.getData("text/html") || "");
  if (html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    const source = template.content.querySelector("img[src]")?.getAttribute("src");
    const imageUrl = usableImageUrl(source);
    if (imageUrl) return imageUrl;
  }
  const candidates = String(dataTransfer?.getData("text/uri-list") || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value && !value.startsWith("#"));
  for (const value of candidates) {
    const imageUrl = usableImageUrl(value, { requireImageExtension: true });
    if (imageUrl) return imageUrl;
  }
  return null;
}

function canDropIntoEditor(dataTransfer) {
  if (!dataTransfer) return false;
  if (imageFileFromDataTransfer(dataTransfer)) return true;
  if (imageUrlFromDataTransfer(dataTransfer)) return true;
  const types = new Set(dataTransfer.types || []);
  return types.has("Files") || types.has("text/uri-list") || types.has("text/plain") || types.has("text/html");
}

function setEditorDropSelection(editor, event) {
  const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (!range || !editor.contains(range.commonAncestorContainer)) return;
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  savedRange = range.cloneRange();
}

function escapedTextToHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .split(/\r?\n/)
    .map((line) => `<p>${line || "<br>"}</p>`)
    .join("");
}

function insertDroppedHtml(html, editor) {
  const template = document.createElement("template");
  template.innerHTML = cleanEditorHtml(html);
  const nodes = [...template.content.childNodes];
  if (nodes.length === 0) return false;
  restoreEditorSelection(editor);
  const selection = window.getSelection();
  const range = selection.rangeCount ? selection.getRangeAt(0) : document.createRange();
  range.deleteContents();
  range.insertNode(template.content);
  range.setStartAfter(nodes[nodes.length - 1]);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  savedRange = range.cloneRange();
  capturePane(editor.closest(".note-pane"));
  scheduleSave();
  return true;
}

function bindPaneEvents(paneElement, pane) {
  const editor = $(".editor", paneElement);
  const title = $(".pane-title", paneElement);
  const menuButton = $(".pane-menu-button", paneElement);
  const menu = $(".pane-menu", paneElement);
  const dragHandle = $(".drag-handle", paneElement);
  const resizeHandle = $(".resize-handle", paneElement);
  const saveButton = $(".pane-save-button", paneElement);
  const removeButton = $(".pane-remove-button", paneElement);
  const imageTools = $(".image-tools", paneElement);
  const headerBlank = $(".pane-header-blank", paneElement);
  let dragDepth = 0;

  paneElement.addEventListener("pointerdown", () => setActivePane(pane.id));
  editor.addEventListener("focus", () => setActivePane(pane.id));
  editor.addEventListener("input", () => {
    capturePane(paneElement);
    scheduleSave();
  });
  editor.addEventListener("paste", (event) => {
    const imageFile = [...event.clipboardData.files].find(isSupportedImageFile);
    if (imageFile) {
      event.preventDefault();
      insertImageFile(imageFile, editor);
      return;
    }
    setTimeout(() => {
      const cleaned = cleanEditorHtml(editor.innerHTML);
      if (cleaned !== editor.innerHTML) editor.innerHTML = cleaned;
      capturePane(paneElement);
      scheduleSave();
    });
  });
  editor.addEventListener("dragenter", (event) => {
    if (!canDropIntoEditor(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth += 1;
    editor.classList.add("drop-target");
  });
  editor.addEventListener("dragover", (event) => {
    if (!canDropIntoEditor(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    editor.classList.add("drop-target");
  });
  editor.addEventListener("dragleave", (event) => {
    if (!canDropIntoEditor(event.dataTransfer)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) editor.classList.remove("drop-target");
  });
  editor.addEventListener("drop", (event) => {
    if (!canDropIntoEditor(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth = 0;
    editor.classList.remove("drop-target");
    setActivePane(pane.id);
    setEditorDropSelection(editor, event);
    const imageFile = imageFileFromDataTransfer(event.dataTransfer);
    if (imageFile) {
      void insertImageFile(imageFile, editor);
      return;
    }
    const imageUrl = imageUrlFromDataTransfer(event.dataTransfer);
    if (imageUrl) {
      void insertImageUrl(imageUrl, editor);
      return;
    }
    const html = event.dataTransfer.getData("text/html");
    const text = event.dataTransfer.getData("text/plain");
    if (html || text) insertDroppedHtml(html || escapedTextToHtml(text), editor);
    else showToast("请拖入文字或图片文件");
  });
  editor.addEventListener("click", (event) => {
    if (event.target.tagName === "IMG") selectImage(event.target, paneElement);
    else clearSelectedImage();
  });

  title.addEventListener("input", () => {
    pane.title = title.value || "未命名分栏";
    pane.updatedAt = new Date().toISOString();
    updatePaneMeta(paneElement, pane);
    scheduleSave();
  });
  headerBlank.addEventListener("dblclick", (event) => {
    event.preventDefault();
    togglePaneMaximize(pane.id);
  });
  headerBlank.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    togglePaneMaximize(pane.id);
  });

  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menu.hidden) openPopup(menu, menuButton);
    else closeMenus();
  });
  $$("[data-pane-color]", menu).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      pane.color = PANE_COLORS.has(button.dataset.paneColor) ? button.dataset.paneColor : "none";
      updatePaneMeta(paneElement, pane);
      closeMenus();
      scheduleSave();
    });
  });
  $$("[data-pane-action]", menu).forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      closeMenus();
      await handlePaneAction(button.dataset.paneAction, pane.id);
    });
  });
  saveButton.addEventListener("click", () => savePane(pane.id));
  removeButton.addEventListener("click", () => removePane(pane.id));

  dragHandle.addEventListener("pointerdown", (event) => startPaneDrag(event, paneElement, pane));
  resizeHandle.addEventListener("pointerdown", (event) => startPaneResize(event, paneElement, pane));
  imageTools.addEventListener("pointerdown", (event) => event.stopPropagation());
  imageTools.addEventListener("click", (event) => {
    if (!selectedImage || selectedImage.paneId !== pane.id) return;
    const widthButton = event.target.closest("[data-image-width]");
    const deleteButton = event.target.closest("[data-image-delete]");
    if (widthButton) selectedImage.element.style.width = `${widthButton.dataset.imageWidth}%`;
    if (deleteButton) {
      selectedImage.element.remove();
      clearSelectedImage();
    }
    capturePane(paneElement);
    scheduleSave();
  });
}

function startPaneDrag(event, paneElement, pane) {
  if (notebook.layout.mode !== "free") {
    startPaneReorder(event, paneElement);
    return;
  }
  event.preventDefault();
  const start = { x: event.clientX, y: event.clientY, frameX: pane.frame.x, frameY: pane.frame.y };
  const move = (moveEvent) => {
    pane.frame.x = Math.max(0, Math.round(start.frameX + moveEvent.clientX - start.x));
    pane.frame.y = Math.max(0, Math.round(start.frameY + moveEvent.clientY - start.y));
    applyPaneFrame(paneElement, pane);
    updateFreeWorkspaceSize();
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    scheduleSave();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end, { once: true });
}

function startPaneReorder(event, paneElement) {
  event.preventDefault();
  event.stopPropagation();
  const start = { x: event.clientX, y: event.clientY };
  const panesById = new Map(notebook.panes.map((pane) => [pane.id, pane]));
  let moved = false;

  const move = (moveEvent) => {
    if (!moved && Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < 6) return;
    moved = true;
    paneElement.classList.add("reordering");
    const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest(".note-pane");
    if (!target || target === paneElement || target.parentElement !== elements.workspace) return;
    const bounds = target.getBoundingClientRect();
    let insertAfter;
    if (notebook.layout.mode === "horizontal") {
      insertAfter = moveEvent.clientX > bounds.left + bounds.width / 2;
    } else if (notebook.layout.mode === "grid") {
      const sameRow = Math.abs(moveEvent.clientY - (bounds.top + bounds.height / 2)) < bounds.height / 3;
      insertAfter = sameRow
        ? moveEvent.clientX > bounds.left + bounds.width / 2
        : moveEvent.clientY > bounds.top + bounds.height / 2;
    } else {
      insertAfter = moveEvent.clientY > bounds.top + bounds.height / 2;
    }
    elements.workspace.insertBefore(paneElement, insertAfter ? target.nextElementSibling : target);
    notebook.panes = $$(".note-pane", elements.workspace).map((element) => panesById.get(element.dataset.id));
  };
  const end = () => {
    paneElement.classList.remove("reordering");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    if (moved) scheduleSave();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end, { once: true });
  window.addEventListener("pointercancel", end, { once: true });
}

function startPaneResize(event, paneElement, pane) {
  event.preventDefault();
  event.stopPropagation();
  const mode = notebook.layout.mode;
  const bounds = paneElement.getBoundingClientRect();
  const start = { x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height };
  const move = (moveEvent) => {
    const width = Math.max(MIN_PANE_WIDTH, Math.round(start.width + moveEvent.clientX - start.x));
    const height = Math.max(MIN_PANE_HEIGHT, Math.round(start.height + moveEvent.clientY - start.y));
    if (mode === "free") {
      pane.frame.width = width;
      pane.frame.height = height;
    }
    if (mode === "horizontal") pane.sizes.horizontal.width = width;
    if (mode === "vertical") pane.sizes.vertical.height = height;
    if (mode === "grid") {
      pane.sizes.grid.width = width;
      pane.sizes.grid.height = height;
    }
    applyPaneFrame(paneElement, pane);
    updateFreeWorkspaceSize();
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    scheduleSave();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end, { once: true });
}

function selectImage(image, paneElement) {
  clearSelectedImage();
  image.classList.add("selected-image");
  const tools = $(".image-tools", paneElement);
  tools.hidden = false;
  selectedImage = { element: image, paneId: paneElement.dataset.id, tools };
}

function clearSelectedImage() {
  if (!selectedImage) return;
  selectedImage.element.classList.remove("selected-image");
  selectedImage.tools.hidden = true;
  selectedImage = null;
}

function restoreEditorSelection(editor) {
  editor.focus();
  const selection = window.getSelection();
  if (savedRange && editor.contains(savedRange.commonAncestorContainer)) {
    selection.removeAllRanges();
    selection.addRange(savedRange);
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function executeEditorCommand(command, value = null) {
  const editor = activeEditor();
  if (!editor) return;
  restoreEditorSelection(editor);
  document.execCommand(command, false, value);
  capturePane(editor.closest(".note-pane"));
  scheduleSave();
  updateFormatState();
}

function updateFormatState() {
  $$('[data-command="bold"], [data-command="italic"], [data-command="underline"], [data-command="strikeThrough"]').forEach((button) => {
    button.classList.toggle("active", document.queryCommandState(button.dataset.command));
  });
}

async function insertImageFile(file, editor = activeEditor()) {
  if (!editor) return;
  if (!isSupportedImageFile(file)) {
    showToast("暂不支持这种图片格式");
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    showToast("图片不能超过 25 MB");
    return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = await window.sideNote.prepareImage({ name: file.name, type: file.type, bytes });
    insertPreparedImage(image, editor);
  } catch (error) {
    console.error("Unable to prepare dropped image", error);
    showToast(error?.message || "无法读取这张图片");
  }
}

async function insertImageUrl(value, editor = activeEditor()) {
  if (!editor) return;
  try {
    const image = await window.sideNote.prepareImageUrl(value);
    insertPreparedImage(image, editor);
  } catch (error) {
    console.error("Unable to prepare dragged image URL", error);
    showToast(error?.message || "无法读取这张图片");
  }
}

function insertPreparedImage(preparedImage, editor = activeEditor()) {
  if (!editor || !preparedImage?.source) return;
  restoreEditorSelection(editor);
  const selection = window.getSelection();
  const range = selection.rangeCount ? selection.getRangeAt(0) : document.createRange();
  const image = document.createElement("img");
  image.src = preparedImage.source;
  image.alt = preparedImage.name || "图片";
  image.contentEditable = "false";
  range.deleteContents();
  range.insertNode(image);
  const paragraph = document.createElement("p");
  paragraph.append(document.createElement("br"));
  image.after(paragraph);
  range.setStart(paragraph, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  savedRange = range.cloneRange();
  const paneElement = editor.closest(".note-pane");
  capturePane(paneElement);
  scheduleSave();
  selectImage(image, paneElement);
}

async function pickAndInsertImage() {
  try {
    const image = await window.sideNote.pickImage();
    if (!image?.canceled) insertPreparedImage(image);
  } catch (error) {
    console.error("Unable to pick image", error);
    showToast(error?.message || "无法读取这张图片");
  }
}

function addPane() {
  captureAllPanes();
  const pane = newPane(`分栏 ${notebook.panes.length + 1}`);
  notebook.panes.push(pane);
  activePaneId = pane.id;
  renderWorkspace({ focusPane: pane.id });
  scheduleSave();
}

async function savePane(id) {
  const pane = paneById(id);
  if (!pane) return false;
  const paneElement = $(`.note-pane[data-id="${CSS.escape(id)}"]`);
  if (paneElement) capturePane(paneElement);
  const previousTargetPath = pane.saveTarget?.path || null;
  setSaveState("saving", "正在写入文件");
  try {
    const result = await window.sideNote.savePane({
      targetPath: pane.saveTarget?.path || null,
      suggestedName: String(pane.title || "添一笔").replace(/[\\/:*?"<>|]/g, "-"),
      pane: { id: pane.id, title: pane.title, html: pane.html }
    });
    if (result?.canceled) return false;
    if (!result?.ok) throw new Error("Save failed");
    const savedAt = new Date().toISOString();
    if (pane.sourceFile?.path === previousTargetPath) {
      pane.sourceFile.path = result.filePath;
    }
    pane.saveTarget = {
      path: result.filePath,
      type: result.type,
      format: result.format,
      scope: "pane",
      savedAt
    };
    pane.externalSave = { ...pane.saveTarget };
    if (result.savedTitle) pane.title = result.savedTitle;
    if (paneElement) {
      $(".pane-title", paneElement).value = pane.title;
      updatePaneMeta(paneElement, pane);
    }
    await window.sideNote.saveNotebook(notebook);
    showToast(result.renamed ? "分栏与源文件题目已更新" : "分栏已写入文件", result.filePath);
    return true;
  } catch (error) {
    console.error(error);
    showToast("保存到文件失败，请重试");
    return false;
  } finally {
    setSaveState("saved", "已保存");
  }
}

async function removePane(id) {
  captureAllPanes();
  const pane = paneById(id);
  if (!pane) return;
  const decision = await window.sideNote.confirmRemovePane({
    title: pane.title,
    hasTarget: Boolean(pane.saveTarget?.path)
  });
  if (decision === "cancel") return;
  if (decision === "save" && !(await savePane(id))) return;

  notebook.panes = notebook.panes.filter((item) => item.id !== id);
  if (notebook.pinnedPaneId === id) notebook.pinnedPaneId = null;
  if (notebook.maximizedPaneId === id) notebook.maximizedPaneId = null;
  if (notebook.panes.length === 0) notebook.panes.push(newPane("随手记", 0));
  activePaneId = notebook.panes[0].id;
  renderWorkspace();
  scheduleSave();
}

async function openFilesAsPanes() {
  setSaveState("saving", "正在打开文件");
  try {
    const result = await window.sideNote.openFiles();
    if (result?.canceled) return;
    const imported = result?.panes || [];
    for (const item of imported) {
      const pane = newPane(item.title);
      pane.html = cleanEditorHtml(item.html);
      pane.sourceFile = normalizeFileRecord(item.sourceFile, "openedAt");
      if (["markdown", "text", "html", "docx"].includes(pane.sourceFile?.format)) {
        pane.saveTarget = {
          path: pane.sourceFile.path,
          type: pane.sourceFile.type,
          format: pane.sourceFile.format,
          scope: "pane",
          savedAt: pane.sourceFile.openedAt
        };
        pane.updatedAt = pane.sourceFile.openedAt;
      }
      notebook.panes.push(pane);
      activePaneId = pane.id;
    }
    if (imported.length > 0) {
      renderWorkspace({ focusPane: activePaneId });
      await saveNow();
    }
    const failed = result?.errors?.length || 0;
    if (imported.length > 0) {
      showToast(failed ? `已打开 ${imported.length} 个文件，${failed} 个未能打开` : `已打开 ${imported.length} 个文件`);
    } else if (failed) {
      showToast(result.errors[0]);
    }
  } catch (error) {
    console.error(error);
    showToast("无法打开所选文件");
  } finally {
    setSaveState("saved", "已保存");
  }
}

async function handlePaneAction(action, id) {
  if (action === "pin") {
    notebook.pinnedPaneId = notebook.pinnedPaneId === id ? null : id;
    $$(".note-pane", elements.workspace).forEach((paneElement) => updatePaneMeta(paneElement));
    scheduleSave();
    showToast(notebook.pinnedPaneId === id ? "此分栏已置顶" : "已取消分栏置顶");
    return;
  }
  const pane = paneById(id);
  if (!pane) return;
  captureAllPanes();
  if (action === "duplicate") {
    const copy = {
      ...structuredClone(pane),
      id: createId(),
      title: `${pane.title} 副本`,
      frame: { ...pane.frame, x: pane.frame.x + 32, y: pane.frame.y + 32 },
      sourceFile: null,
      externalSave: null,
      saveTarget: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    notebook.panes.push(copy);
    activePaneId = copy.id;
    renderWorkspace({ focusPane: copy.id });
    scheduleSave();
    return;
  }
  if (action === "reveal-file") {
    const record = paneFileRecord(pane);
    if (record) await window.sideNote.showInFolder(record.path);
    return;
  }
  const payload = exportPayload([id]);
  if (action === "print") await performPrint(payload);
  if (action === "markdown") await performExport("markdown", payload);
  if (action === "docx") await performExport("docx", payload);
}

function exportPayload(ids = null) {
  captureAllPanes();
  const panes = ids ? notebook.panes.filter((pane) => ids.includes(pane.id)) : notebook.panes;
  const baseName = ids?.length === 1 ? panes[0]?.title : notebook.title;
  return {
    title: ids?.length === 1 ? panes[0]?.title || notebook.title : notebook.title,
    suggestedName: String(baseName || "添一笔").replace(/[\\/:*?"<>|]/g, "-"),
    panes: panes.map(({ id, title, html }) => ({ id, title, html }))
  };
}

async function performPrint(payload = exportPayload()) {
  setSaveState("saving", "准备打印");
  try {
    const result = await window.sideNote.print(payload);
    if (!result.ok && result.error && !/cancel/i.test(result.error)) showToast(`无法打印：${result.error}`);
  } catch (error) {
    showToast("无法打开打印面板");
  } finally {
    setSaveState("saved", "已保存");
  }
}

async function performExport(type, payload = exportPayload()) {
  setSaveState("saving", "正在导出");
  try {
    const result = type === "markdown"
      ? await window.sideNote.exportMarkdown(payload)
      : await window.sideNote.exportDocx(payload);
    if (result?.ok) {
      const savedAt = new Date().toISOString();
      for (const exportedPane of payload.panes) {
        const pane = paneById(exportedPane.id);
        if (!pane) continue;
        pane.externalSave = {
          path: result.filePath,
          type: type === "markdown" ? "Markdown" : "Word",
          format: type,
          scope: "export",
          savedAt
        };
        if (payload.panes.length === 1) {
          pane.saveTarget = { ...pane.externalSave, scope: "pane" };
        }
        const paneElement = $(`.note-pane[data-id="${CSS.escape(pane.id)}"]`);
        if (paneElement) updatePaneMeta(paneElement, pane);
      }
      await window.sideNote.saveNotebook(notebook);
      showToast(type === "markdown" ? "Markdown 已导出" : "Word 文档已导出", result.filePath);
    }
  } catch (error) {
    console.error(error);
    showToast("导出失败，请重试");
  } finally {
    setSaveState("saved", "已保存");
  }
}

function showToast(message, filePath = null) {
  clearTimeout(toastTimer);
  lastExportPath = filePath;
  elements.toastMessage.textContent = message;
  elements.toastAction.hidden = !filePath;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, filePath ? 6000 : 3200);
}

function sortPanes(mode) {
  captureAllPanes();
  const direction = mode.endsWith("-desc") ? -1 : 1;
  if (mode.startsWith("title-")) {
    notebook.panes.sort((left, right) => direction * left.title.localeCompare(right.title, "zh-CN", { numeric: true, sensitivity: "base" }));
  }
  if (mode.startsWith("modified-")) {
    notebook.panes.sort((left, right) => direction * (Date.parse(left.updatedAt || 0) - Date.parse(right.updatedAt || 0)));
  }
  renderWorkspace();
  scheduleSave();
}

function applyShortcutStatus(status) {
  const labels = {
    ready: "已启用 ⌃⌥Z",
    starting: "正在检测",
    unavailable: "快捷键被其他程序占用"
  };
  elements.shortcutStatus.textContent = labels[status] || labels.unavailable;
  elements.shortcutStatus.classList.toggle("warning", status === "unavailable");
}

function bindStaticEvents() {
  $("#add-pane").addEventListener("click", addPane);
  $("#open-files").addEventListener("click", openFilesAsPanes);
  $("#hide-button").addEventListener("click", () => window.sideNote.hideWindow());
  $("#settings-button").addEventListener("click", () => elements.settingsDialog.showModal());
  elements.insertImage.addEventListener("click", () => void pickAndInsertImage());
  elements.alwaysOnTop.addEventListener("click", async () => {
    notebook.preferences.alwaysOnTop = await window.sideNote.setAlwaysOnTop(!notebook.preferences.alwaysOnTop);
    applyPreferences();
    scheduleSave();
  });
  elements.notebookTitle.addEventListener("input", () => {
    notebook.title = elements.notebookTitle.value || "未命名添一笔";
    scheduleSave();
  });
  elements.layoutControl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-layout]");
    if (!button || notebook.layout.mode === button.dataset.layout) return;
    notebook.layout.mode = button.dataset.layout;
    renderWorkspace();
    scheduleSave();
  });
  elements.columnStepper.addEventListener("click", (event) => {
    const button = event.target.closest("[data-columns]");
    if (!button) return;
    notebook.layout.columns = Math.min(4, Math.max(1, notebook.layout.columns + Number(button.dataset.columns)));
    renderWorkspace();
    scheduleSave();
  });

  elements.sortButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (elements.sortMenu.hidden) openPopup(elements.sortMenu, elements.sortButton, "left");
    else closeMenus();
  });
  elements.sortMenu.addEventListener("click", (event) => {
    const button = event.target.closest("[data-sort]");
    if (!button) return;
    closeMenus();
    sortPanes(button.dataset.sort);
  });

  $$("[data-command]").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => executeEditorCommand(button.dataset.command));
  });
  $("#block-format").addEventListener("change", (event) => executeEditorCommand("formatBlock", event.target.value));
  elements.autoHide.addEventListener("change", () => {
    notebook.preferences.autoHide = elements.autoHide.checked;
    window.sideNote.setAutoHide(elements.autoHide.checked);
    scheduleSave();
  });
  elements.loginItem.addEventListener("change", async () => {
    elements.loginItem.disabled = true;
    try {
      elements.loginItem.checked = await window.sideNote.setLoginItem(elements.loginItem.checked);
    } catch {
      elements.loginItem.checked = false;
      showToast("无法更新登录项");
    } finally {
      elements.loginItem.disabled = false;
    }
  });
  elements.shortcutRestart.addEventListener("click", async () => {
    elements.shortcutRestart.disabled = true;
    applyShortcutStatus("starting");
    await window.sideNote.restartShortcut();
    setTimeout(() => { elements.shortcutRestart.disabled = false; }, 800);
  });
  elements.fontSize.addEventListener("input", () => {
    notebook.preferences.fontSize = Number(elements.fontSize.value);
    applyPreferences();
    scheduleSave();
  });
  elements.toastAction.addEventListener("click", () => {
    if (lastExportPath) window.sideNote.showInFolder(lastExportPath);
    elements.toast.hidden = true;
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".menu-anchor")) closeMenus();
    if (!event.target.closest(".editor img") && !event.target.closest(".image-tools")) clearSelectedImage();
  });
  document.addEventListener("selectionchange", () => {
    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const editor = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer.closest?.(".editor")
      : range.commonAncestorContainer.parentElement?.closest(".editor");
    if (editor) {
      savedRange = range.cloneRange();
      setActivePane(editor.closest(".note-pane").dataset.id);
      updateFormatState();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.settingsDialog.open) {
      if ($$(".popup-menu:not([hidden])").length || selectedImage) {
        closeMenus();
        clearSelectedImage();
      } else {
        window.sideNote.hideWindow();
      }
    }
    if (event.metaKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      addPane();
    }
    if (event.metaKey && event.key.toLowerCase() === "o") {
      event.preventDefault();
      openFilesAsPanes();
    }
    if (event.metaKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (activePaneId) savePane(activePaneId);
    }
    if (event.metaKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      performPrint();
    }
  });
  window.addEventListener("beforeunload", () => captureAllPanes());
  window.sideNote.onNewPane(addPane);
  window.sideNote.onShortcutStatus(applyShortcutStatus);
}

function applyPreferences() {
  document.documentElement.style.setProperty("--editor-font-size", `${notebook.preferences.fontSize}px`);
  elements.autoHide.checked = notebook.preferences.autoHide;
  elements.fontSize.value = String(notebook.preferences.fontSize);
  elements.fontSizeLabel.textContent = `${notebook.preferences.fontSize} px`;
  elements.alwaysOnTop.classList.toggle("active", notebook.preferences.alwaysOnTop);
  elements.alwaysOnTop.setAttribute("aria-pressed", String(notebook.preferences.alwaysOnTop));
  elements.alwaysOnTop.title = notebook.preferences.alwaysOnTop ? "取消窗口置顶" : "保持窗口置顶";
}

async function initialize() {
  try {
    notebook = normalizeNotebook(await window.sideNote.loadNotebook());
    activePaneId = notebook.panes[0].id;
    elements.notebookTitle.value = notebook.title;
    applyPreferences();
    bindStaticEvents();
    renderWorkspace();
    refreshIcons();
    await window.sideNote.setAutoHide(notebook.preferences.autoHide);
    notebook.preferences.alwaysOnTop = await window.sideNote.setAlwaysOnTop(notebook.preferences.alwaysOnTop);
    applyPreferences();
    elements.loginItem.checked = await window.sideNote.getLoginItem();
    applyShortcutStatus(await window.sideNote.getShortcutStatus());
    setSaveState("saved", "已保存");
  } catch (error) {
    console.error(error);
    document.body.innerHTML = `<main style="padding:32px;font-family:-apple-system"><h1>添一笔无法启动</h1><p>请退出应用后重新打开。</p></main>`;
  }
}

initialize();
