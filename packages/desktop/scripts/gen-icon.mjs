/**
 * 桌面端图标源生成（05-07 Task 3）：1024x1024 app-icon.png——深色圆角方底
 * + 白色像素风字母 P（PushHub）。纯 Node 实现（zlib deflate + 手写 PNG 块），
 * 零外部依赖；产物交 `tauri icon` 生成 src-tauri/icons/ 正式全套。
 *
 * 用法：node scripts/gen-icon.mjs（在 packages/desktop 下运行）
 */
// 类型注：脚本经 node 直跑（不入 tsc 范围）；node: 导入无需 @types。
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZE = 1024;
const RADIUS = 192; // 圆角半径（像素）
const BG = [27, 30, 43, 255]; // 深色底 #1B1E2B
const FG = [255, 255, 255, 255]; // 字母 P 白

/** 字母 P 点阵（12 宽 × 16 高，# = 填充）。 */
const GLYPH = [
  "############",
  "############",
  "###......###",
  "###......###",
  "###......###",
  "###......###",
  "############",
  "############",
  "###.........",
  "###.........",
  "###.........",
  "###.........",
  "###.........",
  "###.........",
  "###.........",
  "###.........",
];

/** 点阵落位：占画布 2/3 居中。 */
const CELL = Math.floor((SIZE * 2) / 3 / GLYPH.length); // 以高度定格子
const GX = Math.floor((SIZE - CELL * GLYPH[0].length) / 2);
const GY = Math.floor((SIZE - CELL * GLYPH.length) / 2);

/** 圆角方内判定（四角 1/4 圆）。 */
function inRoundedSquare(x, y) {
  const r = RADIUS;
  const far = SIZE - 1 - r;
  let dx = 0;
  let dy = 0;
  if (x < r && y < r) {
    dx = r - x;
    dy = r - y;
  } else if (x > far && y < r) {
    dx = x - far;
    dy = r - y;
  } else if (x < r && y > far) {
    dx = r - x;
    dy = y - far;
  } else if (x > far && y > far) {
    dx = x - far;
    dy = y - far;
  } else {
    return true;
  }
  return dx * dx + dy * dy <= r * r;
}

function glyphAt(x, y) {
  const cx = Math.floor((x - GX) / CELL);
  const cy = Math.floor((y - GY) / CELL);
  if (cy < 0 || cy >= GLYPH.length || cx < 0 || cx >= GLYPH[0].length) return false;
  return GLYPH[cy][cx] === "#";
}

// ---- PNG 编码（RGBA 8bit，filter 0）----

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1)); // 每行前置 filter 字节 0
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter: None
  for (let x = 0; x < SIZE; x++) {
    const px = rowStart + 1 + x * 4;
    const color = inRoundedSquare(x, y) ? (glyphAt(x, y) ? FG : BG) : [0, 0, 0, 0];
    raw[px] = color[0];
    raw[px + 1] = color[1];
    raw[px + 2] = color[2];
    raw[px + 3] = color[3];
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
// 10-12: compression/filter/interlace = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(new URL("../app-icon.png", import.meta.url), png);
console.log(`app-icon.png written: ${SIZE}x${SIZE}, ${png.length} bytes`);
