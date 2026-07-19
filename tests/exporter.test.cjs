const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const JSZip = require("jszip");
const { buildPrintHtml, exportDocx, exportMarkdown, htmlToPlainText, sanitizeHtml, savePaneToFile } = require("../src/services/exporter.cjs");
const { importFile, plainTextToHtml } = require("../src/services/importer.cjs");

const onePixelPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X4f7WQAAAABJRU5ErkJggg==";

function payload() {
  return {
    title: "测试添一笔",
    panes: [{
      id: "one",
      title: "第一栏",
      html: `<p><strong>重点</strong><s>删除</s>内容</p><img src="${onePixelPng}" alt="样图"><script>alert(1)</script>`
    }]
  };
}

test("sanitizeHtml removes executable content", () => {
  const result = sanitizeHtml('<p onclick="alert(1)">安全</p><script>alert(1)</script>');
  assert.equal(result.includes("script"), false);
  assert.equal(result.includes("onclick"), false);
  assert.equal(result.includes("安全"), true);
});

test("Markdown export writes content and image assets", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sidenote-md-"));
  const output = path.join(directory, "测试.md");
  await exportMarkdown(payload(), output);
  const markdown = await fs.readFile(output, "utf8");
  assert.match(markdown, /# 测试添一笔/);
  assert.match(markdown, /\*\*重点\*\*/);
  assert.match(markdown, /~~删除~~/);
  assert.match(markdown, /测试-assets\/pane-1-image-1\.png/);
  assert.equal((await fs.stat(path.join(directory, "测试-assets", "pane-1-image-1.png"))).isFile(), true);
});

test("DOCX export creates an Office Open XML archive", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sidenote-docx-"));
  const output = path.join(directory, "测试.docx");
  await exportDocx(payload(), output);
  const data = await fs.readFile(output);
  assert.equal(data.subarray(0, 2).toString("ascii"), "PK");
  assert.ok(data.length > 1000);
  const archive = await JSZip.loadAsync(data);
  const styles = await archive.file("word/styles.xml").async("string");
  const document = await archive.file("word/document.xml").async("string");
  assert.match(styles, /PingFang SC/);
  assert.match(styles, /w:color w:val="000000"/);
  assert.doesNotMatch(styles, /2E74B5|1F4D78/);
  assert.match(document, /<w:strike\/>/);
});

test("DOCX files can be reopened as editable pane content", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sidenote-reopen-"));
  const output = path.join(directory, "重新打开.docx");
  await exportDocx(payload(), output);
  const imported = await importFile(output);
  assert.equal(imported.title, "重新打开");
  assert.match(imported.html, /重点/);
  assert.equal(imported.sourceFile.path, output);
  assert.equal(imported.sourceFile.type, "Word");
});

test("Markdown, text, and HTML imports become safe pane content", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sidenote-import-"));
  const markdownPath = path.join(directory, "资料.md");
  const htmlPath = path.join(directory, "网页.html");
  await fs.writeFile(markdownPath, "# 标题\n\n**正文**", "utf8");
  await fs.writeFile(htmlPath, '<p>安全</p><img src="javascript:alert(1)"><script>alert(1)</script>', "utf8");

  const markdown = await importFile(markdownPath);
  const html = await importFile(htmlPath);
  assert.match(markdown.html, /<h1>标题<\/h1>/);
  assert.match(markdown.html, /<strong>正文<\/strong>/);
  assert.match(html.html, /安全/);
  assert.equal(html.html.includes("script"), false);
  assert.equal(html.html.includes("javascript:"), false);
  assert.equal(plainTextToHtml("第一行\n第二行"), "<p>第一行<br>第二行</p>");
});

test("pane save writes back Markdown, text, HTML, and Word files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sidenote-save-pane-"));
  const pane = {
    title: "原文件",
    html: "<h1>标题</h1><p><strong>正文</strong><br>第二行</p><script>alert(1)</script>"
  };
  const markdownPath = path.join(directory, "原文件.md");
  const textPath = path.join(directory, "原文件.txt");
  const htmlPath = path.join(directory, "原文件.html");
  const docxPath = path.join(directory, "原文件.docx");
  await fs.writeFile(textPath, "旧内容", "utf8");

  assert.equal((await savePaneToFile(pane, markdownPath)).format, "markdown");
  assert.equal((await savePaneToFile(pane, textPath)).format, "text");
  assert.equal((await savePaneToFile(pane, htmlPath)).format, "html");
  assert.equal((await savePaneToFile(pane, docxPath)).format, "docx");

  assert.match(await fs.readFile(markdownPath, "utf8"), /# 标题[\s\S]*\*\*正文\*\*/);
  assert.equal(await fs.readFile(textPath, "utf8"), "标题\n正文\n第二行\n");
  assert.equal((await fs.readFile(htmlPath, "utf8")).includes("<script>"), false);
  assert.equal((await fs.readFile(docxPath)).subarray(0, 2).toString("ascii"), "PK");
  assert.equal(htmlToPlainText(pane.html), "标题\n正文\n第二行");
});

test("print HTML keeps content and strips scripts", () => {
  const html = buildPrintHtml(payload());
  assert.match(html, /第一栏/);
  assert.equal(html.includes("<script>alert(1)</script>"), false);
});
