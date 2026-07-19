const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { _electron: electron } = require("playwright-core");
const execFileAsync = promisify(execFile);
let application = null;
const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X4f7WQAAAABJRU5ErkJggg==";
const APP_BUNDLE_NAME = "Add a Line";

const executablePath = process.env.SIDENOTE_PACKAGED_APP
  ? path.join(process.env.SIDENOTE_PACKAGED_APP, "Contents", "MacOS", APP_BUNDLE_NAME)
  : path.join(__dirname, "..", "dist", `${APP_BUNDLE_NAME}-darwin-arm64`, `${APP_BUNDLE_NAME}.app`, "Contents", "MacOS", APP_BUNDLE_NAME);

(async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "sidenote-packaged-"));
  application = await electron.launch({
    executablePath,
    env: { ...process.env, SIDENOTE_TEST_USER_DATA: userData }
  });
  const page = await application.firstWindow();
  await page.waitForSelector(".app-shell");
  await page.waitForTimeout(1200);
  const status = await page.locator("#shortcut-status").textContent();
  assert.equal(status.trim(), "已启用 ⌃⌥Z");
  assert.equal(await page.locator("#image-menu").count(), 0);
  await application.evaluate((_electron, png) => {
    global.fetch = async () => new Response(Buffer.from(png, "base64"), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "70" }
    });
  }, onePixelPng);
  await page.locator(".editor").first().evaluate((editor) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/html", '<img src="https://images.example.test/cat" alt="网页图片">');
    const bounds = editor.getBoundingClientRect();
    editor.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, clientX: bounds.left + 24, clientY: bounds.top + 24 }));
  });
  await page.waitForFunction(() => document.querySelector(".editor img")?.src.startsWith("data:image/png"));
  await page.evaluate(() => window.sideNote.restartShortcut());
  await page.waitForFunction(() => document.querySelector("#shortcut-status")?.textContent === "已启用 ⌃⌥Z");

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await execFileAsync("osascript", [
    "-e", "tell application \"System Events\"",
    "-e", "key down control",
    "-e", "key down option",
    "-e", "keystroke \"z\"",
    "-e", "delay 0.2",
    "-e", "key up option",
    "-e", "key up control",
    "-e", "end tell"
  ]);
  await page.waitForTimeout(400);
  const chordTriggered = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
  assert.equal(chordTriggered, true);
  console.log(JSON.stringify({ ok: true, shortcutStatus: status.trim(), webImageDropped: true, chordTriggered }));
  await application.close();
})().catch(async (error) => {
  console.error(error);
  await application?.close();
  process.exitCode = 1;
});
