// 本地合成渲染的质量检查。
// 用 measureText 量出真实文字包围盒，绕开 mock OCR 的假坐标，
// 这样看到的就是「OCR 完全准确时」本地合成能达到的效果上限。
// 运行：node test/render-check.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { ensureFont } from '../server/image/local.js';
import { render } from '../server/image/local.js';

const OUT_DIR = path.resolve('output');
mkdirSync(OUT_DIR, { recursive: true });

const family = ensureFont();
const W = 790;
const H = 1000;

const SPECS = [
  { text: '春季新品', cx: 395, cy: 110, size: 72, color: '#ffffff', on: 'band' },
  { text: '限时特惠 不容错过', cx: 395, cy: 190, size: 34, color: '#ffffff', on: 'band' },
  { text: '全场五折', cx: 395, cy: 520, size: 110, color: '#c8342b', on: 'paper' },
  { text: '活动时间 3月1日 - 3月15日', cx: 395, cy: 880, size: 30, color: '#5a5348', on: 'paper' },
];

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

ctx.fillStyle = '#f4ede2';
ctx.fillRect(0, 0, W, H);
ctx.fillStyle = '#c8342b';
ctx.fillRect(0, 0, W, 250);

ctx.textAlign = 'center';
ctx.textBaseline = 'middle';

// 画字的同时量下真实包围盒
const boxes = [];
for (const spec of SPECS) {
  ctx.font = `${spec.size}px "${family}"`;
  ctx.fillStyle = spec.color;
  ctx.fillText(spec.text, spec.cx, spec.cy);

  const m = ctx.measureText(spec.text);
  const pad = 2;
  const x = Math.round(spec.cx - m.actualBoundingBoxLeft - pad);
  const y = Math.round(spec.cy - m.actualBoundingBoxAscent - pad);
  const w = Math.round(m.actualBoundingBoxLeft + m.actualBoundingBoxRight + pad * 2);
  const h = Math.round(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent + pad * 2);
  boxes.push({ x, y, w, h });
}

const before = await canvas.encode('jpeg', 92);
writeFileSync(path.join(OUT_DIR, 'render-before.jpg'), before);

const NEW_TEXTS = ['夏季新品', '钜惠来袭 抓紧下单', '全场三折', '活动时间 7月1日 - 7月31日'];

const changes = SPECS.map((spec, i) => ({
  original: spec.text,
  modified: NEW_TEXTS[i],
  fontSize: spec.size,
  box: boxes[i],
}));

console.log('真实包围盒:');
for (const [i, box] of boxes.entries()) {
  console.log(`  "${SPECS[i].text}"  ${box.w}×${box.h} @ (${box.x},${box.y})  ${SPECS[i].size}px`);
}

const out = await render({ imageBuffer: before, changes });
writeFileSync(path.join(OUT_DIR, 'render-after.jpg'), out.buffer);

console.log('\n改动:');
for (const c of changes) console.log(`  "${c.original}" → "${c.modified}"`);
if (out.notes.length) console.log('\n提示:', out.notes.join(' / '));
console.log('\n→ output/render-before.jpg  /  output/render-after.jpg');
