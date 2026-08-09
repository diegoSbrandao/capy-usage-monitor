'use strict';
// Gera um PNG 32x32 solido (marrom capivara) sem dependencias externas,
// usando apenas zlib (built-in) para compressao dos scanlines.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makePng(size, [r, g, b], drawFn) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = chunk('IHDR', ihdrData);

  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const px = drawFn(x, y) || [r, g, b, 255];
      const off = rowStart + 1 + x * 4;
      raw[off] = px[0];
      raw[off + 1] = px[1];
      raw[off + 2] = px[2];
      raw[off + 3] = px[3];
    }
  }
  const idat = chunk('IDAT', zlib.deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

// Criatura pixel pessego simples: corpo + 2 pernas + olhos, inspirada no
// bichinho do claude-usage-monitor mas desenhada do zero.
function drawMascot(x, y) {
  const margin = 5;
  const legTop = 25;
  const inBody = x >= margin && x < 32 - margin && y >= margin && y < legTop;
  const inLeftLeg = x >= 8 && x < 13 && y >= legTop && y < 32 - 3;
  const inRightLeg = x >= 19 && x < 24 && y >= legTop && y < 32 - 3;
  if (!inBody && !inLeftLeg && !inRightLeg) return [0, 0, 0, 0];

  // olhos
  if (inBody && y >= 12 && y < 15 && (x >= 10 && x < 13)) return [36, 26, 18, 255];
  if (inBody && y >= 12 && y < 15 && (x >= 19 && x < 22)) return [36, 26, 18, 255];

  return inLeftLeg || inRightLeg ? [201, 122, 73, 255] : [221, 140, 94, 255];
}

const out = makePng(32, [221, 140, 94], drawMascot);
const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), out);
console.log('icon.png gerado em', dir);
