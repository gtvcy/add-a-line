const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const outputDirectory = path.join(__dirname, "..", "assets");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    rows[row] = 0;
    rgba.copy(rows, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function canvas(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

function blendPixel(target, x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= target.width || y >= target.height) return;
  const offset = (y * target.width + x) * 4;
  const sourceAlpha = (color[3] / 255) * alpha;
  const destinationAlpha = target.data[offset + 3] / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outputAlpha === 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    target.data[offset + channel] = Math.round((color[channel] * sourceAlpha + target.data[offset + channel] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  }
  target.data[offset + 3] = Math.round(outputAlpha * 255);
}

function roundedRect(target, x, y, width, height, radius, color) {
  const samples = 4;
  for (let py = Math.floor(y); py < Math.ceil(y + height); py += 1) {
    for (let px = Math.floor(x); px < Math.ceil(x + width); px += 1) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const pointX = px + (sx + 0.5) / samples;
          const pointY = py + (sy + 0.5) / samples;
          const closestX = Math.max(x + radius, Math.min(pointX, x + width - radius));
          const closestY = Math.max(y + radius, Math.min(pointY, y + height - radius));
          if ((pointX - closestX) ** 2 + (pointY - closestY) ** 2 <= radius ** 2) hits += 1;
        }
      }
      if (hits) blendPixel(target, px, py, color, hits / (samples * samples));
    }
  }
}

function makeAppIcon() {
  const target = canvas(1024, 1024);
  roundedRect(target, 48, 48, 928, 928, 214, [239, 239, 235, 255]);
  roundedRect(target, 182, 156, 660, 712, 112, [41, 41, 39, 255]);
  roundedRect(target, 292, 220, 462, 584, 42, [255, 255, 252, 255]);
  roundedRect(target, 338, 282, 18, 448, 9, [189, 73, 61, 255]);
  roundedRect(target, 397, 302, 294, 23, 11, [53, 107, 140, 255]);
  roundedRect(target, 397, 365, 246, 15, 7, [127, 127, 119, 255]);
  roundedRect(target, 397, 417, 272, 15, 7, [127, 127, 119, 255]);
  roundedRect(target, 397, 469, 218, 15, 7, [127, 127, 119, 255]);
  roundedRect(target, 397, 557, 276, 15, 7, [127, 127, 119, 255]);
  roundedRect(target, 397, 609, 238, 15, 7, [127, 127, 119, 255]);
  roundedRect(target, 397, 672, 42, 42, 21, [45, 115, 88, 255]);
  return encodePng(target.width, target.height, target.data);
}

function makeTrayIcon() {
  const target = canvas(36, 36);
  roundedRect(target, 4, 4, 28, 28, 6, [0, 0, 0, 255]);
  roundedRect(target, 10, 9, 16, 18, 2, [255, 255, 255, 255]);
  roundedRect(target, 12, 12, 2, 12, 1, [0, 0, 0, 255]);
  roundedRect(target, 17, 13, 6, 2, 1, [0, 0, 0, 255]);
  roundedRect(target, 17, 18, 6, 2, 1, [0, 0, 0, 255]);
  roundedRect(target, 17, 23, 4, 2, 1, [0, 0, 0, 255]);
  return encodePng(target.width, target.height, target.data);
}

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, "AppIcon-1024.png"), makeAppIcon());
fs.writeFileSync(path.join(outputDirectory, "trayTemplate.png"), makeTrayIcon());
