const fs = require("node:fs/promises");
const path = require("node:path");
const mammoth = require("mammoth");
const { marked } = require("marked");
const { sanitizeHtml } = require("./exporter.cjs");

const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"]
]);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function plainTextToHtml(text) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n");
  if (!normalized) return "<p><br></p>";
  return normalized
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replaceAll("\n", "<br>")}</p>`)
    .join("");
}

async function assertFileSize(filePath, maximum) {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error("请选择普通文件");
  if (stats.size > maximum) throw new Error(`文件不能超过 ${Math.round(maximum / 1024 / 1024)} MB`);
}

async function importDocx(filePath) {
  await assertFileSize(filePath, MAX_DOCUMENT_BYTES);
  const result = await mammoth.convertToHtml(
    { path: filePath },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const contentType = String(image.contentType || "").toLowerCase();
        if (![...IMAGE_TYPES.values()].includes(contentType)) return { src: "" };
        return { src: `data:${contentType};base64,${await image.read("base64")}` };
      })
    }
  );
  return sanitizeHtml(result.value || "<p><br></p>");
}

async function importFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const title = path.basename(filePath, extension) || path.basename(filePath);
  let html;
  let type;
  let format;

  if (IMAGE_TYPES.has(extension)) {
    await assertFileSize(filePath, 15 * 1024 * 1024);
    const mime = IMAGE_TYPES.get(extension);
    const data = await fs.readFile(filePath);
    html = `<p><img src="data:${mime};base64,${data.toString("base64")}" alt="${escapeHtml(path.basename(filePath))}"></p>`;
    type = "图片";
    format = "image";
  } else if ([".md", ".markdown"].includes(extension)) {
    await assertFileSize(filePath, MAX_TEXT_BYTES);
    html = sanitizeHtml(marked.parse(await fs.readFile(filePath, "utf8"), { gfm: true, breaks: true }));
    type = "Markdown";
    format = "markdown";
  } else if ([".txt", ".text"].includes(extension)) {
    await assertFileSize(filePath, MAX_TEXT_BYTES);
    html = plainTextToHtml(await fs.readFile(filePath, "utf8"));
    type = "文本";
    format = "text";
  } else if ([".html", ".htm"].includes(extension)) {
    await assertFileSize(filePath, MAX_TEXT_BYTES);
    html = sanitizeHtml(await fs.readFile(filePath, "utf8"));
    type = "HTML";
    format = "html";
  } else if (extension === ".docx") {
    html = await importDocx(filePath);
    type = "Word";
    format = "docx";
  } else {
    throw new Error("暂不支持这种文件格式");
  }

  return {
    title,
    html: html || "<p><br></p>",
    sourceFile: {
      path: filePath,
      type,
      format,
      openedAt: new Date().toISOString()
    }
  };
}

module.exports = { importDocx, importFile, plainTextToHtml };
