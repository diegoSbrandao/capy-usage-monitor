'use strict';
// Gera os icones do app (PNG pra bandeja, ICO pra instalador/exe do
// Windows) sem dependencias externas — so `zlib` (builtin) pra comprimir
// os PNGs, e um wrapper ICO feito na mao (formato moderno: PNG cru
// embutido, suportado pelo Windows desde o Vista, sem precisar de
// BMP/mascara AND-XOR).
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

function makePng(size, drawFn) {
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
      const px = drawFn(x, y) || [0, 0, 0, 0];
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

// Mesmo desenho pixel-art do mascote atual (grade 11x10 de renderer/index.html
// e style.css: cabeca arredondada, olhos losango, boca, 4 pernas em duas
// cores) — reescalado pra qualquer tamanho de icone via nearest-neighbor.
const ROWS = [
  '   #####   ',
  '  #######  ',
  ' ######### ',
  '###########',
  '##o#####o##',
  '###########',
  '####___####',
  '###########',
  ' A B   B A ',
  ' A B   B A ',
];
const GRID_COLS = 11;
const GRID_ROWS = 10;

// RGB aproximado das cores oklch usadas em style.css (.mp-body/.mp-eye/
// .mp-mouth/.mp-leg-a/.mp-leg-b) — nao precisa ser exato, e um icone
// pequeno.
const COLOR = {
  '#': [237, 130, 90, 255], // mp-body
  o: [40, 30, 22, 255], // mp-eye
  _: [40, 30, 22, 255], // mp-mouth
  A: [176, 104, 58, 255], // mp-leg-a
  B: [150, 88, 50, 255], // mp-leg-b
};

function drawMascot(x, y, size) {
  const col = Math.min(GRID_COLS - 1, Math.floor((x / size) * GRID_COLS));
  const row = Math.min(GRID_ROWS - 1, Math.floor((y / size) * GRID_ROWS));
  const ch = ROWS[row][col];
  if (ch === ' ') return [0, 0, 0, 0];
  return COLOR[ch] || [0, 0, 0, 0];
}

function pngIconBuffer(size) {
  return makePng(size, (x, y) => drawMascot(x, y, size));
}

// ICO com uma unica imagem PNG embutida (formato moderno, Windows Vista+).
function makeIco(sizes) {
  const images = sizes.map((size) => pngIconBuffer(size));
  const headerSize = 6 + 16 * images.length;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(images.length, 4);

  let offset = headerSize;
  const entries = [];
  for (let i = 0; i < images.length; i++) {
    const size = sizes[i];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height (0 = 256)
    entry.writeUInt8(0, 2); // color count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(images[i].length, 8); // size in bytes
    entry.writeUInt32LE(offset, 12); // offset
    entries.push(entry);
    offset += images[i].length;
  }
  return Buffer.concat([dir, ...entries, ...images]);
}

const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(path.join(dir, 'icon.png'), pngIconBuffer(32));
console.log('icon.png (32x32, bandeja) gerado em', dir);

fs.writeFileSync(path.join(dir, 'icon.ico'), makeIco([16, 32, 48, 256]));
console.log('icon.ico (16/32/48/256, instalador/exe) gerado em', dir);
