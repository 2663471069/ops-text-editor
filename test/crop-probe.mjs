// 从截图里裁出海报区域，跑一次真实 OCR，用来复现英文分词碎片问题。
//   node test/crop-probe.mjs <图片路径> [x] [y] [w] [h]

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { detectText } from '../server/ocr/index.js';
import { getSecrets } from '../server/config.js';

const [file, ...rect] = process.argv.slice(2);
if (!file) {
  console.error('用法: node test/crop-probe.mjs <图片路径> [x y w h]');
  process.exit(1);
}

const source = await loadImage(file);
const [x, y, w, h] = rect.length === 4 ? rect.map(Number) : [0, 0, source.width, source.height];
console.log(`源图 ${source.width}×${source.height}，裁剪区域 ${w}×${h} @ (${x},${y})`);

const canvas = createCanvas(w, h);
canvas.getContext('2d').drawImage(source, x, y, w, h, 0, 0, w, h);
const buffer = await canvas.encode('jpeg', 95);

mkdirSync(path.resolve('output'), { recursive: true });
writeFileSync(path.resolve('output', 'crop.jpg'), buffer);

const secrets = getSecrets().ocr;
const { elements, rawCount } = await detectText({
  provider: secrets.provider,
  credentials: secrets,
  imageBase64Body: buffer.toString('base64'),
  canvas: { width: w, height: h },
  minAreaPercent: 0.02,
  excludeRects: [],
});

console.log(`\n原始 ${rawCount} 条 → 归一化 ${elements.length} 条:\n`);
for (const el of elements) {
  console.log(`  ${String(el.zIndex + 1).padStart(2)}. "${el.text}"`.padEnd(46) + `${el.w}×${el.h} @ (${el.x},${el.y})`);
}
console.log('\n→ output/crop.jpg');
