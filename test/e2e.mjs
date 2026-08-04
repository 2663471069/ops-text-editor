// 端到端：启服务 → 造一张海报 → 识别 → 改文案 → 生成 → 轮询 → 存图。
// 顺带验证任务归属隔离（换个 cookie 读不到别人的任务）。
// 运行：node test/e2e.mjs

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { ensureFont } from '../server/image/local.js';

const BASE = `http://127.0.0.1:${process.env.PORT ?? 8787}`;
const OUT_DIR = path.resolve('output');

await import('../server/index.js'); // 启动服务
await new Promise((r) => setTimeout(r, 400));

// ---------- 造一张纯色背景的促销海报 ----------

function makePoster() {
  const family = ensureFont();
  const canvas = createCanvas(790, 1000);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#f4ede2';
  ctx.fillRect(0, 0, 790, 1000);
  ctx.fillStyle = '#c8342b';
  ctx.fillRect(0, 0, 790, 250);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#ffffff';
  ctx.font = `72px "${family}"`;
  ctx.fillText('春季新品', 395, 110);
  ctx.font = `34px "${family}"`;
  ctx.fillText('限时特惠 不容错过', 395, 190);

  ctx.fillStyle = '#c8342b';
  ctx.font = `110px "${family}"`;
  ctx.fillText('全场五折', 395, 520);

  ctx.fillStyle = '#5a5348';
  ctx.font = `30px "${family}"`;
  ctx.fillText('活动时间 3月1日 - 3月15日', 395, 880);

  return canvas.encode('jpeg', 92);
}

const posterBuffer = await makePoster();
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, 'e2e-before.jpg'), posterBuffer);
const imageBase64 = `data:image/jpeg;base64,${posterBuffer.toString('base64')}`;
console.log(`原图 ${posterBuffer.length} 字节 → output/e2e-before.jpg`);

// ---------- 带 cookie 的请求helper ----------

function makeClient() {
  let cookie = '';
  return async function call(pathname, options = {}) {
    const response = await fetch(BASE + pathname, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(options.headers ?? {}) },
    });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    const body = await response.json();
    return { status: response.status, body };
  };
}

const alice = makeClient();
const bob = makeClient();

// ---------- 1. 健康检查 ----------

const health = await alice('/api/health');
assert.equal(health.status, 200);
console.log(`服务状态: OCR=${health.body.ocrProvider} 出图=${health.body.imageProvider}`);

// ---------- 2. 识别 ----------

const detect = await alice('/api/ocr/detect', {
  method: 'POST',
  body: JSON.stringify({ imageBase64 }),
});
assert.equal(detect.status, 200, JSON.stringify(detect.body));
const { elements, canvas } = detect.body.data;
assert.ok(elements.length > 0, '应识别到文字');
console.log(`\n识别到 ${elements.length} 处（画布 ${canvas.width}×${canvas.height}）:`);
for (const el of elements) {
  console.log(`  ${el.zIndex + 1}. "${el.text}"  ${el.w}×${el.h} @ (${el.x},${el.y})  ${el.fontSize}px`);
}

// ---------- 3. 校验拒绝路径 ----------

const badImage = await alice('/api/ocr/detect', {
  method: 'POST',
  body: JSON.stringify({ imageBase64: 'data:image/png;base64,!!!' }),
});
assert.equal(badImage.status, 400);
console.log(`\n非法 base64 被拒: ${badImage.body.error}`);

const noChanges = await alice('/api/ocr/generate', {
  method: 'POST',
  body: JSON.stringify({ imageBase64 }),
});
assert.equal(noChanges.status, 400);
console.log(`空变更被拒: ${noChanges.body.error}`);

// ---------- 4. 生成 ----------

const changes = elements.slice(0, 3).map((el, i) => ({
  original: el.text,
  modified: ['夏季新品', '钜惠来袭 抓紧下单', '全场三折'][i] ?? el.text,
  isVertical: el.isVertical,
  fontSize: el.fontSize,
  box: { x: el.x, y: el.y, w: el.w, h: el.h },
}));

const generate = await alice('/api/ocr/generate', {
  method: 'POST',
  body: JSON.stringify({ imageBase64, changes }),
});
assert.equal(generate.status, 200, JSON.stringify(generate.body));
const { taskId } = generate.body;
console.log(`\n任务已创建: ${taskId}`);

// ---------- 5. 归属隔离 ----------

const stolen = await bob(`/api/ocr/task/${taskId}`);
assert.equal(stolen.status, 404, '别的用户不该读到这个任务');
console.log(`归属隔离: 另一个用户查询返回 ${stolen.status} ${stolen.body.error}`);

// ---------- 6. 轮询 ----------

let result = null;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  const poll = await alice(`/api/ocr/task/${taskId}`);
  assert.equal(poll.status, 200);
  if (poll.body.status === 'completed') {
    result = poll.body;
    break;
  }
  if (poll.body.status === 'failed') throw new Error(`任务失败: ${poll.body.error}`);
}
assert.ok(result, '轮询超时');

// ---------- 7. 存图 ----------

const dataUrl = result.data[0];
assert.match(dataUrl, /^data:image\/jpeg;base64,/, '本地合成应返回 data URL');
const outBuffer = Buffer.from(dataUrl.split(',')[1], 'base64');
writeFileSync(path.join(OUT_DIR, 'e2e-after.jpg'), outBuffer);

console.log(`\n生成完成 (${result.resultMode}, ${outBuffer.length} 字节) → output/e2e-after.jpg`);
console.log('\n改动内容:');
for (const c of changes) console.log(`  "${c.original}" → "${c.modified}"`);
console.log('\n端到端通过 ✓');
process.exit(0);
