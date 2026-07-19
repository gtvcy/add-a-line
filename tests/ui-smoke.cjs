const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { _electron: electron } = require("playwright-core");

const root = path.join(__dirname, "..");
const screenshots = path.join(root, "screenshots");
let application = null;
const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X4f7WQAAAABJRU5ErkJggg==";

async function setWindowBounds(width, height) {
  await application.evaluate(({ BrowserWindow }, bounds) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setBounds({ x: 80, y: 80, ...bounds });
    window.show();
    window.focus();
  }, { width, height });
}

async function capture(filename) {
  const page = await application.firstWindow();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(screenshots, filename) });
}

async function dragResize(page, mode, deltaX, deltaY) {
  await page.locator(`[data-layout="${mode}"]`).click();
  const pane = page.locator(".note-pane").first();
  const before = await pane.boundingBox();
  const box = await pane.locator(".resize-handle").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + deltaX, box.y + box.height / 2 + deltaY, { steps: 5 });
  await page.mouse.up();
  const after = await pane.boundingBox();
  if (deltaX) assert.ok(after.width >= before.width + deltaX - 3, `${mode} width did not resize: ${before.width} -> ${after.width}`);
  if (deltaY) assert.ok(after.height >= before.height + deltaY - 3, `${mode} height did not resize: ${before.height} -> ${after.height}`);
  await capture(`v1.5-${mode}.png`);
}

(async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "sidenote-ui-"));
  const originalNote = path.join(userData, "随手记.md");
  const externalImage = path.join(userData, "外部图片.png");
  await fs.writeFile(originalNote, "旧内容\n", "utf8");
  await fs.writeFile(externalImage, Buffer.from(onePixelPng, "base64"));
  await fs.mkdir(screenshots, { recursive: true });
  await fs.writeFile(path.join(userData, "notebook.json"), JSON.stringify({
    version: 1,
    title: "我的添一笔",
    layout: { mode: "vertical", columns: 2 },
    preferences: { autoHide: false, alwaysOnTop: false, fontSize: 16 },
    panes: [{
      id: "saved-pane",
      title: "随手记",
      html: "<p><br></p>",
      frame: { x: 28, y: 28, width: 430, height: 360 },
      sourceFile: { path: originalNote, type: "Markdown", format: "markdown", openedAt: new Date().toISOString() },
      saveTarget: { path: originalNote, type: "Markdown", format: "markdown", scope: "pane", savedAt: new Date().toISOString() },
      externalSave: { path: originalNote, type: "Markdown", format: "markdown", scope: "pane", savedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }]
  }), "utf8");
  application = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      SIDENOTE_TEST_USER_DATA: userData
    }
  });
  const page = await application.firstWindow();
  await page.waitForSelector(".app-shell");

  await setWindowBounds(360, 700);
  await page.waitForTimeout(200);
  const narrow = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    titlebarWidth: document.querySelector(".titlebar").getBoundingClientRect().width,
    shortcutKeys: [...document.querySelectorAll(".shortcut-keys kbd")].map((key) => key.textContent).join("")
  }));
  assert.ok(narrow.viewportWidth <= 360, `window remained wider than requested: ${narrow.viewportWidth}`);
  assert.equal(narrow.bodyScrollWidth, narrow.viewportWidth);
  assert.equal(narrow.titlebarWidth, narrow.viewportWidth);
  assert.equal(narrow.shortcutKeys, "⌃⌥Z");
  assert.equal(await page.locator(".pane-file-state").count(), 0);
  assert.equal(await page.locator("#print-all, #export-button").count(), 0);
  assert.equal(await page.locator('[data-command="createLink"]').count(), 0);
  assert.equal(await page.locator('[data-command="strikeThrough"]').count(), 1);
  assert.equal(await page.locator("#camera-picker, #image-picker").count(), 0);
  const formatOrder = await page.evaluate(() => [...document.querySelector(".format-bar").children].map((item) => {
    if (item.id === "insert-image" || item.querySelector("#insert-image")) return "image";
    return item.dataset.command || item.id || item.tagName;
  }));
  assert.equal(formatOrder.indexOf("image"), formatOrder.indexOf("redo") + 1);
  assert.equal(await page.locator("#image-menu, [data-image-source]").count(), 0);
  assert.equal(await page.locator(".pane-save-button").count(), 1);
  assert.equal(await page.locator(".pane-save-button").first().textContent(), "保存");
  assert.equal(await page.locator(".pane-remove-button").count(), 1);
  assert.equal(await page.locator(".pane-remove-button").first().textContent(), "移除");
  assert.equal(await page.locator(".pane-save-button.needs-first-save").count(), 0);
  assert.equal(await page.locator('.note-pane[data-pane-color="none"]').count(), 1);
  await capture("v1.5-narrow-360.png");

  await setWindowBounds(1120, 812);
  const sourcePaneId = await page.locator(".note-pane").first().getAttribute("data-id");
  const firstEditor = page.locator(".editor").first();
  await firstEditor.fill("需要删除线");
  await firstEditor.selectText();
  await page.locator('[data-command="strikeThrough"]').click();
  assert.match(await firstEditor.innerHTML(), /<(s|strike)>需要删除线<\/(s|strike)>/i);

  await page.locator(".pane-title").first().fill("改名后的随手记");
  await page.locator(".editor").first().fill("写入原文件");
  await page.locator(".pane-save-button").first().click();
  await page.waitForFunction(() => document.querySelector("#toast-message")?.textContent === "分栏与源文件题目已更新");
  const renamedOriginalNote = path.join(userData, "改名后的随手记.md");
  assert.match(await fs.readFile(renamedOriginalNote, "utf8"), /写入原文件/);
  await assert.rejects(fs.readFile(originalNote, "utf8"), { code: "ENOENT" });

  await page.locator("#always-on-top-button").click();
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), true);
  await page.locator("#always-on-top-button").click();

  await page.locator("#add-pane").click();
  await page.locator("#add-pane").click();
  assert.equal(await page.locator(".note-pane").count(), 3);
  assert.equal(await page.locator(".pane-save-button.needs-first-save").count(), 2);

  const maximizePaneId = await page.locator(".note-pane").nth(1).getAttribute("data-id");
  const restoreBox = await page.locator(`.note-pane[data-id="${maximizePaneId}"]`).boundingBox();
  await page.locator(`.note-pane[data-id="${maximizePaneId}"] .pane-header-blank`).dblclick();
  await page.waitForFunction((id) => document.querySelector(`.note-pane[data-id="${id}"]`)?.classList.contains("maximized"), maximizePaneId);
  const workspaceBox = await page.locator("#workspace").boundingBox();
  const maximizedBox = await page.locator(`.note-pane[data-id="${maximizePaneId}"]`).boundingBox();
  assert.ok(maximizedBox.width >= workspaceBox.width - 26);
  assert.ok(maximizedBox.height >= workspaceBox.height - 26);
  assert.equal(await page.locator(".workspace.has-maximized-pane .note-pane").evaluateAll((items) => items.filter((item) => getComputedStyle(item).display !== "none").length), 1);
  await capture("v1.5-maximized.png");
  await page.locator(`.note-pane[data-id="${maximizePaneId}"] .pane-header-blank`).dblclick();
  await page.waitForFunction(() => document.querySelectorAll(".note-pane.maximized").length === 0);
  const restoredBox = await page.locator(`.note-pane[data-id="${maximizePaneId}"]`).boundingBox();
  assert.ok(Math.abs(restoredBox.width - restoreBox.width) < 3);
  assert.ok(Math.abs(restoredBox.height - restoreBox.height) < 3);

  const savedNewNote = path.join(userData, "另存分栏.md");
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, savedNewNote);
  await page.locator(".pane-save-button").nth(1).click();
  await page.waitForFunction(() => document.querySelectorAll(".pane-save-button.needs-first-save").length === 1);
  assert.equal(await page.locator('.note-pane[data-pane-color="none"]').count(), 3);
  const neutralPaneColors = await page.locator(".note-pane").evaluateAll((items) => items.map((item) => getComputedStyle(item).backgroundColor));
  assert.equal(new Set(neutralPaneColors).size, 1);

  await page.locator(".pane-menu-button").nth(1).click();
  assert.equal(await page.locator(".pane-menu:not([hidden]) .color-swatch").count(), 7);
  await page.locator('.pane-menu:not([hidden]) [data-pane-color="blue"]').click();
  assert.equal(await page.locator('.note-pane[data-pane-color="blue"]').count(), 1);
  await page.waitForTimeout(220);
  const chosenPaneColors = await page.locator(".note-pane").evaluateAll((items) => items.map((item) => getComputedStyle(item).backgroundColor));
  assert.equal(new Set(chosenPaneColors).size, 2);
  await capture("v1.5-pane-color.png");

  const dropEditor = page.locator(".editor").nth(1);
  const dropTargetActive = await dropEditor.evaluate((editor) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/html", "<p><strong>外部富文本</strong></p><script>window.bad = true</script>");
    dataTransfer.setData("text/plain", "外部富文本");
    const bounds = editor.getBoundingClientRect();
    editor.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer, clientX: bounds.left + 24, clientY: bounds.top + 24 }));
    const active = editor.classList.contains("drop-target");
    editor.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, clientX: bounds.left + 24, clientY: bounds.top + 24 }));
    return active;
  });
  assert.equal(dropTargetActive, true);
  await page.waitForFunction(() => document.querySelectorAll(".editor")[1].innerText.includes("外部富文本"));
  assert.match(await dropEditor.innerHTML(), /<strong>外部富文本<\/strong>/);
  assert.equal((await dropEditor.innerHTML()).includes("script"), false);

  const imageDropEditor = page.locator(".editor").nth(2);
  await imageDropEditor.evaluate((editor, png) => {
    const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([bytes], "外部图片.png", { type: "image/png" }));
    const bounds = editor.getBoundingClientRect();
    editor.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, clientX: bounds.left + 24, clientY: bounds.top + 24 }));
  }, onePixelPng);
  await page.waitForFunction(() => document.querySelectorAll(".editor")[2].querySelector("img")?.src.startsWith("data:image/png"));

  await imageDropEditor.evaluate((editor, uri) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/uri-list", uri);
    const bounds = editor.getBoundingClientRect();
    editor.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, clientX: bounds.left + 24, clientY: bounds.top + 24 }));
  }, pathToFileURL(externalImage).href);
  await page.waitForFunction(() => document.querySelectorAll(".editor")[2].querySelectorAll("img").length === 2);

  await application.evaluate((_electron, png) => {
    global.fetch = async () => new Response(Buffer.from(png, "base64"), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "70" }
    });
  }, onePixelPng);
  await imageDropEditor.evaluate((editor) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/html", '<img src="https://images.example.test/cat" alt="网页图片">');
    const bounds = editor.getBoundingClientRect();
    editor.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, clientX: bounds.left + 24, clientY: bounds.top + 24 }));
  });
  await page.waitForFunction(() => document.querySelectorAll(".editor")[2].querySelectorAll("img").length === 3);
  assert.equal(await imageDropEditor.locator("img").last().getAttribute("src").then((value) => value.startsWith("data:image/png")), true);

  await application.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, externalImage);
  await firstEditor.click();
  await page.locator("#insert-image").click();
  await page.waitForFunction(() => document.querySelectorAll(".editor")[0].querySelector("img")?.src.startsWith("data:image/png"));

  const titles = page.locator(".pane-title");
  await titles.nth(0).fill("C");
  await titles.nth(1).fill("A");
  await titles.nth(2).fill("B");
  const sortBox = await page.locator("#sort-button").boundingBox();
  const layoutBox = await page.locator("#layout-control").boundingBox();
  assert.ok(sortBox.x < layoutBox.x);
  await page.locator("#sort-button").click();
  await page.waitForTimeout(170);
  const menuState = await page.locator("#sort-menu").evaluate((menu) => {
    const bounds = menu.getBoundingClientRect();
    const style = getComputedStyle(menu);
    return {
      bounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      topmost: document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest("#sort-menu") === menu
    };
  });
  assert.equal(menuState.display, "block");
  assert.equal(menuState.visibility, "visible");
  assert.equal(menuState.opacity, "1");
  assert.ok(menuState.bounds.width > 0 && menuState.bounds.height > 0);
  assert.equal(menuState.topmost, true);
  await capture("v1.5-sort-menu.png");
  assert.equal(await page.locator("#sort-menu [data-sort]").count(), 4);
  await page.locator('[data-sort="title-asc"]').click();
  assert.deepEqual(await page.locator(".pane-title").evaluateAll((items) => items.map((item) => item.value)), ["A", "B", "C"]);

  await page.locator("#sort-button").click();
  await page.locator('[data-sort="title-desc"]').click();
  assert.deepEqual(await page.locator(".pane-title").evaluateAll((items) => items.map((item) => item.value)), ["C", "B", "A"]);

  await page.waitForTimeout(20);
  const paneAIndex = await page.locator(".note-pane").evaluateAll((items) => items.findIndex((item) => item.querySelector(".pane-title").value === "A"));
  const paneA = page.locator(".note-pane").nth(paneAIndex);
  await paneA.locator(".editor").fill("最近修改");
  await page.locator("#sort-button").click();
  await page.locator('[data-sort="modified-desc"]').click();
  assert.equal(await page.locator(".pane-title").first().inputValue(), "A");
  await page.locator("#sort-button").click();
  await page.locator('[data-sort="modified-asc"]').click();
  assert.equal(await page.locator(".pane-title").last().inputValue(), "A");

  await page.locator('[data-layout="horizontal"]').click();
  const beforeDrag = await page.locator(".pane-title").evaluateAll((items) => items.map((item) => item.value));
  const dragHandle = await page.locator(".drag-handle").first().boundingBox();
  const dragTarget = await page.locator(".note-pane").last().boundingBox();
  await page.mouse.move(dragHandle.x + dragHandle.width / 2, dragHandle.y + dragHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(dragTarget.x + dragTarget.width - 12, dragTarget.y + 20, { steps: 8 });
  await page.mouse.up();
  const afterDrag = await page.locator(".pane-title").evaluateAll((items) => items.map((item) => item.value));
  assert.notDeepEqual(afterDrag, beforeDrag);

  await dragResize(page, "horizontal", 70, 0);
  await dragResize(page, "vertical", 0, 70);
  await dragResize(page, "grid", 50, 50);
  await dragResize(page, "free", 50, 50);

  const handles = await page.locator(".resize-handle").evaluateAll((items) => items.map((item) => getComputedStyle(item).display));
  assert.ok(handles.every((display) => display === "grid"));
  await page.locator(".pane-menu-button").first().click();
  await page.waitForTimeout(170);
  await capture("v1.5-pin-menu.png");
  const pinButton = page.locator('.pane-menu:not([hidden]) [data-pane-action="pin"]');
  const pinHitTarget = await pinButton.evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return {
      action: hit?.closest("[data-pane-action]")?.dataset.paneAction || null,
      sameButton: hit === button || button.contains(hit),
      insideAnchor: Boolean(hit?.closest(".menu-anchor")),
      hitClass: hit?.getAttribute("class") || hit?.tagName || null
    };
  });
  assert.equal(pinHitTarget.action, "pin");
  assert.equal(pinHitTarget.sameButton, true);
  assert.equal(pinHitTarget.insideAnchor, true);
  await pinButton.click();
  await page.waitForFunction(() => document.querySelectorAll(".note-pane.pinned").length === 1);
  assert.equal(await page.locator(".note-pane.pinned").count(), 1);
  assert.equal(await page.locator(".note-pane.pinned .pane-pin-indicator:not([hidden])").count(), 1);
  const paneZIndexes = await page.locator(".note-pane").evaluateAll((items) => items.map((item) => Number(getComputedStyle(item).zIndex) || 0));
  assert.ok(Math.max(...paneZIndexes) >= 60);
  assert.equal(await page.locator(".pane-menu:not([hidden])").count(), 0);
  await capture("v1.5-pinned-color.png");

  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await page.locator(`.note-pane[data-id="${sourcePaneId}"] .pane-remove-button`).click();
  await page.waitForFunction(() => document.querySelectorAll(".note-pane").length === 2);
  assert.equal((await fs.stat(renamedOriginalNote)).isFile(), true);
  console.log(JSON.stringify({ ok: true, narrow, panesAfterRemove: 2, layouts: ["horizontal", "vertical", "grid", "free"] }));
  await application.close();
})().catch(async (error) => {
  console.error(error);
  await application?.close();
  process.exitCode = 1;
});
