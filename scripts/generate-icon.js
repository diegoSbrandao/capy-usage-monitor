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

// Capivara minimalista: circulo marrom com "focinho" mais claro e dois pontos de olho.
function drawCapy(x, y) {
  const size = 32;
  const cx = size / 2;
  const cy = size / 2 + 2;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // olhos
  if (Math.abs(x - 11) <= 1 && Math.abs(y - 13) <= 1) return [30, 20, 10, 255];
  if (Math.abs(x - 21) <= 1 && Math.abs(y - 13) <= 1) return [30, 20, 10, 255];

  // focinho
  const mdx = x - cx;
  const mdy = y - (cy + 6);
  if (Math.sqrt(mdx * mdx + mdy * mdy) < 6) return [196, 154, 108, 255];

  if (dist < 15) return [139, 98, 58, 255]; // corpo marrom
  return [0, 0, 0, 0]; // transparente
}

const out = makePng(32, [139, 98, 58], drawCapy);
const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), out);
console.log('icon.png gerado em', dir);
