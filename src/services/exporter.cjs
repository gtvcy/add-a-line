const fs = require("node:fs/promises");
const path = require("node:path");
const TurndownService = require("turndown");
const { gfm } = require("turndown-plugin-gfm");
const { parseHTML } = require("linkedom");
const { imageSize } = require("image-size");
const {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  Paragraph,
  TextRun,
  UnderlineType
} = require("docx");

const DOCX_FONT = "PingFang SC";
const DOCX_COLOR = "000000";

function safeName(value, fallback = "添一笔") {
  const cleaned = String(value || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 80) || fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseBody(html) {
  return parseHTML(`<!doctype html><html><head></head><body>${html || ""}</body></html>`).document;
}

function sanitizeHtml(html) {
  const document = parseBody(html);
  document.querySelectorAll("script, style, iframe, object, embed, link, meta").forEach((node) => node.remove());
  document.querySelectorAll("*").forEach((node) => {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith("on") || (["href", "src"].includes(name) && /^(javascript|vbscript):/.test(value))) {
        node.removeAttribute(attribute.name);
      }
    }
  });
  return document.body.innerHTML;
}

function decodeDataUrl(source) {
  const match = /^data:image\/(png|jpe?g|gif|webp);base64,([a-z0-9+/=\s]+)$/i.exec(source || "");
  if (!match) return null;
  const format = match[1].toLowerCase().replace("jpeg", "jpg");
  return { format, data: Buffer.from(match[2].replace(/\s/g, ""), "base64") };
}

async function materializeImages(html, outputFile, paneIndex) {
  const base = path.basename(outputFile, path.extname(outputFile));
  const assetsFolderName = `${base}-assets`;
  const assetsPath = path.join(path.dirname(outputFile), assetsFolderName);
  const expression = /<img\b([^>]*?)\bsrc=(['"])(data:image\/(?:png|jpe?g|gif|webp);base64,[^'"]+)\2([^>]*)>/gi;
  let cursor = 0;
  let imageIndex = 0;
  let result = "";
  let match;

  while ((match = expression.exec(html)) !== null) {
    result += html.slice(cursor, match.index);
    const decoded = decodeDataUrl(match[3]);
    if (!decoded) {
      result += match[0];
    } else {
      imageIndex += 1;
      await fs.mkdir(assetsPath, { recursive: true });
      const imageName = `pane-${paneIndex + 1}-image-${imageIndex}.${decoded.format}`;
      await fs.writeFile(path.join(assetsPath, imageName), decoded.data);
      const relative = `${assetsFolderName}/${imageName}`;
      result += `<img${match[1]}src="${relative}"${match[4]}>`;
    }
    cursor = expression.lastIndex;
  }
  result += html.slice(cursor);
  return result;
}

function createMarkdownConverter() {
  const turndown = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    headingStyle: "atx"
  });
  turndown.use(gfm);
  turndown.addRule("strikethrough", {
    filter: (node) => ["S", "STRIKE", "DEL"].includes(node.nodeName),
    replacement: (content) => content ? `~~${content}~~` : ""
  });
  turndown.addRule("underlined", {
    filter: (node) => node.nodeName === "U",
    replacement: (content) => content
  });
  return turndown;
}

async function markdownFromHtml(html, outputFile, paneIndex = 0) {
  const safeHtml = sanitizeHtml(html);
  const withFiles = await materializeImages(safeHtml, outputFile, paneIndex);
  return createMarkdownConverter().turndown(withFiles).trim();
}

async function exportMarkdown(payload, outputFile) {
  const panes = payload.panes || [];
  const sections = [`# ${payload.title || "添一笔"}`];
  for (let index = 0; index < panes.length; index += 1) {
    const pane = panes[index];
    const markdown = await markdownFromHtml(pane.html, outputFile, index);
    sections.push(`## ${pane.title || `分栏 ${index + 1}`}\n\n${markdown}`.trim());
  }
  await fs.writeFile(outputFile, `${sections.join("\n\n---\n\n")}\n`, "utf8");
}

function inlineStyle(node, inherited = {}) {
  if (node.nodeType !== 1) return inherited;
  const tag = node.tagName.toLowerCase();
  const style = node.getAttribute("style") || "";
  return {
    bold: inherited.bold || tag === "b" || tag === "strong" || /font-weight:\s*(bold|[6-9]00)/i.test(style),
    italics: inherited.italics || tag === "i" || tag === "em" || /font-style:\s*italic/i.test(style),
    underline: inherited.underline || tag === "u" || /text-decoration[^;]*underline/i.test(style),
    strike: inherited.strike || tag === "s" || tag === "strike" || /text-decoration[^;]*line-through/i.test(style)
  };
}

function imageRunFromNode(node) {
  const decoded = decodeDataUrl(node.getAttribute("src"));
  if (!decoded) return null;
  let dimensions = { width: 520, height: 320 };
  try {
    const measured = imageSize(decoded.data);
    if (measured.width && measured.height) dimensions = measured;
  } catch {}
  const ratio = Math.min(1, 540 / dimensions.width, 680 / dimensions.height);
  const type = decoded.format === "jpg" ? "jpg" : decoded.format;
  return new ImageRun({
    data: decoded.data,
    type,
    transformation: {
      width: Math.max(1, Math.round(dimensions.width * ratio)),
      height: Math.max(1, Math.round(dimensions.height * ratio))
    }
  });
}

function inlineRuns(node, inherited = {}) {
  if (node.nodeType === 3) {
    if (!node.nodeValue) return [];
    return [new TextRun({
      text: node.nodeValue,
      font: DOCX_FONT,
      color: DOCX_COLOR,
      ...inherited,
      underline: inherited.underline ? { type: UnderlineType.SINGLE } : undefined
    })];
  }
  if (node.nodeType !== 1) return [];
  const tag = node.tagName.toLowerCase();
  if (tag === "br") return [new TextRun({ break: 1 })];
  if (tag === "img") {
    const image = imageRunFromNode(node);
    return image ? [image] : [];
  }

  const style = inlineStyle(node, inherited);
  const children = [...node.childNodes].flatMap((child) => inlineRuns(child, style));
  if (tag === "a" && node.getAttribute("href")) {
    return [new ExternalHyperlink({
      link: node.getAttribute("href"),
      children: children.length ? children : [new TextRun({
        text: node.textContent || node.getAttribute("href"),
        font: DOCX_FONT,
        color: DOCX_COLOR
      })]
    })];
  }
  return children;
}

function paragraphForNode(node, options = {}) {
  const runs = inlineRuns(node);
  const paragraphOptions = { children: runs.length ? runs : [new TextRun({ text: "", font: DOCX_FONT, color: DOCX_COLOR })] };
  if (options.heading) paragraphOptions.heading = options.heading;
  if (options.bullet) paragraphOptions.bullet = { level: options.level || 0 };
  if (options.numbering) paragraphOptions.numbering = { reference: "add-a-line-numbering", level: options.level || 0 };
  return new Paragraph(paragraphOptions);
}

function htmlToDocxParagraphs(html) {
  const document = parseBody(sanitizeHtml(html));
  const output = [];

  function visit(node, listType = null, level = 0) {
    if (node.nodeType === 3) {
      if (node.nodeValue?.trim()) output.push(new Paragraph({ children: [new TextRun({ text: node.nodeValue, font: DOCX_FONT, color: DOCX_COLOR })] }));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    const headingMap = {
      h1: HeadingLevel.HEADING_1,
      h2: HeadingLevel.HEADING_2,
      h3: HeadingLevel.HEADING_3,
      h4: HeadingLevel.HEADING_4
    };
    if (headingMap[tag]) {
      output.push(paragraphForNode(node, { heading: headingMap[tag] }));
      return;
    }
    if (tag === "ul" || tag === "ol") {
      [...node.children].forEach((child) => visit(child, tag, level));
      return;
    }
    if (tag === "li") {
      output.push(paragraphForNode(node, {
        bullet: listType === "ul",
        numbering: listType === "ol",
        level
      }));
      [...node.children].filter((child) => ["ul", "ol"].includes(child.tagName?.toLowerCase())).forEach((child) => visit(child, child.tagName.toLowerCase(), level + 1));
      return;
    }
    if (tag === "img") {
      const image = imageRunFromNode(node);
      if (image) output.push(new Paragraph({ children: [image], alignment: AlignmentType.LEFT }));
      return;
    }
    if (["p", "div", "blockquote", "pre"].includes(tag)) {
      output.push(paragraphForNode(node));
      return;
    }
    [...node.childNodes].forEach((child) => visit(child, listType, level));
  }

  [...document.body.childNodes].forEach((node) => visit(node));
  return output.length ? output : [new Paragraph("")];
}

function createDocxDocument(children) {
  return new Document({
    styles: {
      default: {
        document: { run: { font: DOCX_FONT, color: DOCX_COLOR, size: 24 } },
        title: { run: { font: DOCX_FONT, color: DOCX_COLOR, size: 40, bold: true } },
        heading1: { run: { font: DOCX_FONT, color: DOCX_COLOR, size: 32, bold: true } },
        heading2: { run: { font: DOCX_FONT, color: DOCX_COLOR, size: 28, bold: true } },
        heading3: { run: { font: DOCX_FONT, color: DOCX_COLOR, size: 25, bold: true } },
        heading4: { run: { font: DOCX_FONT, color: DOCX_COLOR, size: 24, bold: true } },
        heading5: { run: { font: DOCX_FONT, color: DOCX_COLOR, size: 24, bold: true } },
        heading6: { run: { font: DOCX_FONT, color: DOCX_COLOR, size: 24, bold: true } },
        strong: { run: { font: DOCX_FONT, color: DOCX_COLOR, bold: true } },
        listParagraph: { run: { font: DOCX_FONT, color: DOCX_COLOR } },
        hyperlink: { run: { font: DOCX_FONT, color: DOCX_COLOR } }
      }
    },
    numbering: {
      config: [{
        reference: "add-a-line-numbering",
        levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START }]
      }]
    },
    sections: [{
      properties: {
        page: { margin: { top: 900, right: 900, bottom: 900, left: 900 } }
      },
      children
    }]
  });
}

async function exportDocx(payload, outputFile) {
  const children = [
    new Paragraph({
      children: [new TextRun({ text: payload.title || "添一笔", font: DOCX_FONT, color: DOCX_COLOR, bold: true })],
      heading: HeadingLevel.TITLE
    })
  ];
  const panes = payload.panes || [];
  panes.forEach((pane, index) => {
    if (index > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(new Paragraph({
      children: [new TextRun({ text: pane.title || `分栏 ${index + 1}`, font: DOCX_FONT, color: DOCX_COLOR, bold: true })],
      heading: HeadingLevel.HEADING_1
    }));
    children.push(...htmlToDocxParagraphs(pane.html));
  });

  const document = createDocxDocument(children);
  await fs.writeFile(outputFile, await Packer.toBuffer(document));
}

function htmlToPlainText(html) {
  const document = parseBody(sanitizeHtml(html));
  const blockTags = new Set(["address", "article", "blockquote", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "p", "pre", "section"]);
  let output = "";

  function append(value) {
    output += value;
  }

  function visit(node) {
    if (node.nodeType === 3) {
      append(node.nodeValue || "");
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "br") {
      append("\n");
      return;
    }
    if (tag === "img") {
      append(node.getAttribute("alt") ? `[${node.getAttribute("alt")}]` : "[图片]");
      return;
    }
    if (tag === "li" && !output.endsWith("\n")) append("\n");
    [...node.childNodes].forEach(visit);
    if (blockTags.has(tag) && !output.endsWith("\n")) append("\n");
  }

  [...document.body.childNodes].forEach(visit);
  return output.replace(/\n{3,}/g, "\n\n").trimEnd();
}

async function savePaneToFile(pane, outputFile) {
  const extension = path.extname(outputFile).toLowerCase();
  if ([".md", ".markdown"].includes(extension)) {
    await fs.writeFile(outputFile, `${await markdownFromHtml(pane.html, outputFile)}\n`, "utf8");
    return { format: "markdown", type: "Markdown" };
  }
  if ([".txt", ".text"].includes(extension)) {
    await fs.writeFile(outputFile, `${htmlToPlainText(pane.html)}\n`, "utf8");
    return { format: "text", type: "文本" };
  }
  if ([".html", ".htm"].includes(extension)) {
    const html = `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(pane.title || "添一笔")}</title></head><body>${sanitizeHtml(pane.html)}</body></html>\n`;
    await fs.writeFile(outputFile, html, "utf8");
    return { format: "html", type: "HTML" };
  }
  if (extension === ".docx") {
    const children = [
      new Paragraph({
        children: [new TextRun({ text: pane.title || "添一笔", font: DOCX_FONT, color: DOCX_COLOR, bold: true })],
        heading: HeadingLevel.TITLE
      }),
      ...htmlToDocxParagraphs(pane.html)
    ];
    await fs.writeFile(outputFile, await Packer.toBuffer(createDocxDocument(children)));
    return { format: "docx", type: "Word" };
  }
  throw new Error("暂不支持写入这种文件格式");
}

function buildPrintHtml(payload) {
  const panes = payload.panes || [];
  const content = panes.map((pane, index) => `
    <section class="pane ${index > 0 ? "page-break" : ""}">
      <h2>${escapeHtml(pane.title || `分栏 ${index + 1}`)}</h2>
      <div class="content">${sanitizeHtml(pane.html)}</div>
    </section>
  `).join("");
  return `<!doctype html>
  <html lang="zh-CN"><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
  <title>${escapeHtml(payload.title || "添一笔")}</title>
  <style>
    @page { margin: 18mm; }
    body { color:#181817; font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif; font-size:12pt; line-height:1.65; }
    h1 { font-size:22pt; margin:0 0 18pt; } h2 { font-size:16pt; margin:0 0 12pt; border-bottom:1px solid #bbb; padding-bottom:6pt; }
    .pane.page-break { break-before:page; } .content img { max-width:100%; height:auto; } p { margin:0 0 8pt; }
    blockquote { border-left:3px solid #999; margin-left:0; padding-left:12pt; color:#555; }
  </style></head><body><h1>${escapeHtml(payload.title || "添一笔")}</h1>${content}</body></html>`;
}

module.exports = {
  buildPrintHtml,
  exportDocx,
  exportMarkdown,
  htmlToPlainText,
  safeName,
  sanitizeHtml,
  savePaneToFile
};
