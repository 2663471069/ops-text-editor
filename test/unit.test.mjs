// 覆盖原规格 TEST-CHECKLIST.md 的单元测试项，外加针对已修复问题的回归用例。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseGenerateRequest, parseDetectRequest, parseImageDataUrl } from '../server/validate.js';
import { buildTextEditorPrompt, formatChange, isRemovalInstruction, validateTemplate, normalizeText, DEFAULT_TEMPLATE } from '../server/prompt.js';
import { describePosition } from '../server/position.js';
import { createQueue } from '../server/queue.js';
import { createTaskStore } from '../server/task-store.js';
import { DEFAULT_IMAGE_ESTIMATE, estimateDurationRange, parseCompletedCodexDurations } from '../server/task-metrics.js';
import { normalizeElements, polygonToBox, mergeSameLine } from '../server/ocr/index.js';
import { buildCodexPrompt, DEFAULT_CODEX_IMAGE_TIMEOUT_MS } from '../server/image/codex.js';
import { buildCodexOcrPrompt } from '../server/ocr/codex.js';
import { IMAGE_PROVIDERS, OCR_PROVIDERS } from '../server/config.js';
import { createWorkspaceStore } from '../server/workspace-store.js';
import { describeFontFile } from '../server/fonts.js';

// 1x1 白色 PNG
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const baseChange = {
  original: '标题',
  modified: '新标题',
  position: '约在画面上方中间 (参考坐标 x:50%, y:12%)',
};

// ---------- 输入校验 ----------

test('空图片 / 空 prompt / 非法 data URL 都被拒绝', () => {
  assert.equal(parseGenerateRequest({}).error, '缺少原始图片');
  assert.equal(parseGenerateRequest({ imageBase64: PNG_1X1 }).error, '缺少提示词或文字变更');
  assert.match(parseGenerateRequest({ imageBase64: 'not-a-data-url', prompt: 'p' }).error, /data:image/);
});

test('base64 载荷非法时拒绝（原参考实现只查前缀就放行）', () => {
  const result = parseImageDataUrl('data:image/png;base64,!!!not-base64!!!');
  assert.equal(result.error, 'base64 数据非法');
});

test('声明的 MIME 与实际内容不符时拒绝', () => {
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');
  const result = parseImageDataUrl(`data:image/png;base64,${jpegHeader}`);
  assert.match(result.error, /与声明的类型 image\/png 不符/);
});

test('prompt 超长被拒绝（原参考实现无长度上限）', () => {
  const result = parseGenerateRequest({ imageBase64: PNG_1X1, prompt: 'x'.repeat(500_000) });
  assert.match(result.error, /提示词超过 8000 字上限/);
});

test('minAreaPercent 越界被拒绝', () => {
  assert.match(parseDetectRequest({ imageBase64: PNG_1X1, minAreaPercent: 101 }).error, /0-100/);
  assert.equal(parseDetectRequest({ imageBase64: PNG_1X1, minAreaPercent: 0.5 }).minAreaPercent, 0.5);
});

test('Codex 出图渠道已注册，提示词保留结构化替换与输出路径', () => {
  assert.ok(IMAGE_PROVIDERS.includes('codex'));
  const prompt = buildCodexPrompt({
    changes: [
      {
        original: '春季新品',
        modified: '夏季新品',
        position: '画面顶部中间',
        box: { x: 100, y: 80, w: 300, h: 70 },
      },
    ],
    outputPath: 'C:\\jobs\\result.jpg',
    templatePrompt: '严格保持原图排版',
  });
  assert.match(prompt, /\$poster-text-edit/);
  assert.match(prompt, /\$imagegen/);
  assert.match(prompt, /"original": "春季新品"/);
  assert.match(prompt, /"modified": "夏季新品"/);
  assert.match(prompt, /C:\\jobs\\result\.jpg/);
  assert.match(prompt, /SERVER_LAYOUT_GUIDANCE/);
  assert.match(prompt, /严格保持原图排版/);
  assert.match(prompt, /STYLE LOCK \(mandatory\)/);
  assert.match(prompt, /SIZE LOCK \(mandatory\)/);
  assert.match(prompt, /COLOR LOCK \(mandatory\)/);
  assert.match(prompt, /preserve the original font appearance\/typeface/);
  assert.match(prompt, /Never enlarge shorter replacement text/);
});

test('Codex 清除操作会恢复识别框背景且绝不绘制指令词', () => {
  const prompt = buildCodexPrompt({
    changes: [{
      original: 'XS SQUARE',
      modified: '',
      remove: true,
      position: '画面顶部中间',
      box: { x: 100, y: 80, w: 180, h: 40 },
    }],
    outputPath: 'C:\\jobs\\result.jpg',
  });
  assert.match(prompt, /"operation": "remove_text_and_restore_background"/);
  assert.match(prompt, /"modified": null/);
  assert.match(prompt, /erase every visible letter, outline, shadow/);
  assert.match(prompt, /Do not render any replacement word or instruction label/);
});

test('Codex 复杂图片允许最多运行 25 分钟', () => {
  assert.equal(DEFAULT_CODEX_IMAGE_TIMEOUT_MS, 25 * 60 * 1000);
});

test('公司字体文件会识别字体族、字重和斜体', () => {
  const regular = describeFontFile('C:\\fonts\\Poppins\\Poppins-SemiBold.ttf', 'C:\\fonts');
  assert.equal(regular.id, 'Poppins/Poppins-SemiBold.ttf');
  assert.equal(regular.family, 'Poppins');
  assert.equal(regular.variant, 'SemiBold');
  const italic = describeFontFile('C:\\fonts\\Emerland\\Emerland-Italic.otf', 'C:\\fonts');
  assert.equal(italic.family, 'Emerland');
  assert.equal(italic.variant, 'Regular Italic');
});

test('Codex OCR 渠道已注册，识别提示词固定画布坐标并防止图片提示注入', () => {
  assert.ok(OCR_PROVIDERS.includes('codex'));
  const prompt = buildCodexOcrPrompt({ width: 790, height: 1000 });
  assert.match(prompt, /790 by 1000 pixels/);
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /output schema/);
});

// ---------- 提示词构造 ----------

test('单条与多条变更都能正确替换三个占位符', () => {
  const one = buildTextEditorPrompt({ canvasSize: '790 × 1499', changes: [baseChange] });
  assert.match(one, /画布尺寸: 790 × 1499/);
  assert.match(one, /共1处/);
  assert.match(one, /1\. 原文: 「标题」 → 改为: 「新标题」/);
  assert.doesNotMatch(one, /\{\{/);

  const many = buildTextEditorPrompt({
    canvasSize: '800 × 600',
    changes: [baseChange, { ...baseChange, original: '副标题', modified: '新副标题' }],
  });
  assert.match(many, /共2处/);
  assert.match(many, /2\. 原文: 「副标题」/);
});

test('换行被保留为 ⏎ 并标注行数（原实现会压成空格丢失分行）', () => {
  const line = formatChange({ ...baseChange, original: '春季新品\n全场五折', modified: '夏季新品\n全场三折' }, 0);
  assert.match(line, /「春季新品⏎全场五折」/);
  assert.match(line, /「夏季新品⏎全场三折」/);
  assert.match(line, /分2行/);
});

test('行内空白被折叠，前后空格被去掉', () => {
  assert.equal(normalizeText('  春季   新品  '), '春季 新品');
  assert.equal(normalizeText('第一行  \n\n  第二行'), '第一行\n\n第二行');
});

test('用户文案里的双引号原样保留（原实现会改成中文右引号）', () => {
  const line = formatChange({ ...baseChange, original: '他说"你好"', modified: '她说"再见"' }, 0);
  assert.match(line, /「他说"你好"」/);
  assert.match(line, /「她说"再见"」/);
});

test('模板缺任一占位符时构造与保存都失败', () => {
  for (const bad of ['{{canvasSize}} {{changeCount}}', '{{changes}}', '没有占位符']) {
    assert.throws(() => buildTextEditorPrompt({ canvasSize: '1 × 1', changes: [baseChange], template: bad }), /missing/);
    assert.match(validateTemplate(bad).error, /缺少占位符/);
  }
  assert.equal(validateTemplate(DEFAULT_TEMPLATE).template, DEFAULT_TEMPLATE.trim());
});

test('对齐方式与额外调整只影响对应的变更行', () => {
  const prompt = buildTextEditorPrompt({
    canvasSize: '800 × 600',
    changes: [
      { ...baseChange, alignmentMode: 'center', extraInstruction: '向上移动' },
      { ...baseChange, original: '第二处', modified: '新第二处' },
    ],
  });
  const [first, second] = prompt.split('\n').filter((l) => /^\d\. /.test(l));
  assert.match(first, /居中对齐/);
  assert.match(first, /其他调整: 向上移动/);
  assert.doesNotMatch(second, /居中对齐/);
  assert.doesNotMatch(second, /其他调整/);
});

test('非法 alignmentMode 抛错而非静默忽略', () => {
  assert.throws(() => formatChange({ ...baseChange, alignmentMode: 'justify' }, 0), /invalid alignmentMode/);
});

test('缺 original / modified / position 都抛错', () => {
  assert.throws(() => formatChange({ ...baseChange, original: '' }, 0), /missing original/);
  assert.throws(() => formatChange({ ...baseChange, modified: '   ' }, 0), /missing modified/);
  assert.throws(() => formatChange({ original: 'a', modified: 'b' }, 0), /missing position/);
});

test('输入消除、删除、去除或清除会转换成识别框清除操作', () => {
  for (const keyword of ['消除', '删除', '去除', '清除']) {
    assert.equal(isRemovalInstruction(keyword), true);
    const line = formatChange({ ...baseChange, modified: keyword }, 0);
    assert.match(line, /操作: 清除文字并自然补全该识别框背景/);
    assert.doesNotMatch(line, /改为: 「消除」|改为: 「删除」|改为: 「去除」|改为: 「清除」/);
  }
  assert.equal(isRemovalInstruction('消除文字'), false, '只有完整指令词才触发，避免误伤正常文案');
});

test('占位符只替换一轮，插入内容不会被二次展开', () => {
  const prompt = buildTextEditorPrompt({
    canvasSize: '790 × 1499 {{changeCount}}',
    changes: [baseChange],
  });
  // canvasSize 里的 {{changeCount}} 必须原样保留，不能被展开成 1
  assert.match(prompt, /画布尺寸: 790 × 1499 \{\{changeCount\}\}/);
});

test('isVertical 与 fontSize 会写进提示词', () => {
  const line = formatChange({ ...baseChange, isVertical: true, fontSize: 27.4 }, 0);
  assert.match(line, /竖排/);
  assert.match(line, /原字号约27px/);
});

// ---------- 位置描述 ----------

test('位置描述稳定且分区正确', () => {
  const canvas = { width: 1000, height: 1000 };
  assert.match(describePosition({ x: 400, y: 60, w: 200, h: 40 }, canvas), /^约在画面顶部中间 \(参考坐标 x:50%, y:8%\)$/);
  // 只有垂直中部 + 水平中间同时成立才叫「正中」，其余按 中部/最左 直接拼
  assert.match(describePosition({ x: 20, y: 480, w: 100, h: 40 }, canvas), /约在画面中部最左/);
  assert.match(describePosition({ x: 450, y: 470, w: 100, h: 60 }, canvas), /^约在画面正中 /);
  assert.match(describePosition({ x: 800, y: 900, w: 150, h: 60 }, canvas), /约在画面底部最右/);
});

test('通栏文字会被标注横跨画面宽度', () => {
  const text = describePosition({ x: 10, y: 100, w: 980, h: 60 }, { width: 1000, height: 1000 });
  assert.match(text, /横跨画面宽度/);
});

test('同一输入每次输出一致', () => {
  const box = { x: 123, y: 456, w: 78, h: 90 };
  const canvas = { width: 800, height: 1200 };
  assert.equal(describePosition(box, canvas), describePosition(box, canvas));
});

test('非法坐标抛错', () => {
  assert.throws(() => describePosition({ x: 0, y: 0, w: 0, h: 10 }, { width: 100, height: 100 }), /包围盒非法/);
  assert.throws(() => describePosition({ x: 0, y: 0, w: 10, h: 10 }, { width: 0, height: 100 }), /canvas 尺寸非法/);
});

// ---------- 并发槽位 ----------

test('单用户与全局并发上限都生效', () => {
  const queue = createQueue({ perUser: 2, globalMax: 3 });
  const a1 = queue.tryAcquire('a');
  const a2 = queue.tryAcquire('a');
  assert.ok(a1 && a2);
  assert.equal(queue.tryAcquire('a'), null, '超出单用户上限应拿不到槽位');

  const b1 = queue.tryAcquire('b');
  assert.ok(b1);
  assert.equal(queue.tryAcquire('b'), null, '超出全局上限应拿不到槽位');

  a1.release();
  assert.ok(queue.tryAcquire('b'), '释放后应能再拿到');
});

test('重复 release 不会把计数减穿', () => {
  const queue = createQueue({ perUser: 1, globalMax: 1 });
  const slot = queue.tryAcquire('a');
  slot.release();
  slot.release();
  slot.release();
  assert.equal(queue.stats().globalCount, 0);
  assert.ok(queue.tryAcquire('a'));
});

test('run() 在回调抛错时仍释放槽位', async () => {
  const queue = createQueue({ perUser: 1, globalMax: 1 });
  await assert.rejects(queue.run('a', async () => {
    throw new Error('boom');
  }), /boom/);
  assert.equal(queue.stats().globalCount, 0, '异常路径必须释放槽位');
});

test('并发满时 run() 抛 429', async () => {
  const queue = createQueue({ perUser: 1, globalMax: 1 });
  queue.tryAcquire('a');
  await assert.rejects(queue.run('a', async () => 'ok'), (error) => {
    assert.equal(error.statusCode, 429);
    return true;
  });
});

// ---------- 任务归属 ----------

test('任务查询隔离到所属用户', () => {
  const store = createTaskStore();
  const task = store.create({ ownerId: 'user-a', prompt: 'p' });

  assert.ok(store.get(task.id, 'user-a'));
  assert.equal(store.get(task.id, 'user-b'), null, '别的用户不能凭 taskId 读到');
  assert.equal(store.get(task.id, undefined), null, '不传归属也读不到');
  assert.equal(store.get('不存在的-id', 'user-a'), null);
});

test('创建任务必须带 ownerId', () => {
  const store = createTaskStore();
  assert.throws(() => store.create({ prompt: 'p' }), /ownerId is required/);
});

test('对外视图不含 ownerId 和 prompt', () => {
  const store = createTaskStore();
  const task = store.create({ ownerId: 'user-a', prompt: '秘密提示词' });
  const view = store.toPublic(task);
  assert.equal(view.ownerId, undefined);
  assert.equal(view.prompt, undefined);
  assert.equal(view.status, 'processing');
});

test('完成与失败状态流转正确，且不可重复终结', () => {
  const store = createTaskStore();
  const task = store.create({ ownerId: 'u', prompt: 'p' });
  assert.ok(store.complete(task.id, ['https://x/1.jpg']));
  assert.equal(store.get(task.id, 'u').status, 'completed');
  assert.equal(store.fail(task.id, '来晚了'), null, '已完成的任务不该再被改成失败');
});

test('任务公开状态包含失败时间和耗时，便于定位长任务超时', () => {
  let clock = 1_000;
  const store = createTaskStore({ now: () => clock });
  const task = store.create({ ownerId: 'u', prompt: 'p' });
  clock = 6_500;
  store.fail(task.id, '超时');
  const view = store.toPublic(task);
  assert.equal(view.failedAt, 6_500);
  assert.equal(view.elapsedMs, 5_500);
});

// ---------- 草稿与生成记录 ----------

test('草稿可持久化、恢复编辑并按用户隔离', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'poster-draft-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createWorkspaceStore({ dataDir });
  const owner = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const image = Buffer.from(PNG_1X1.split(',')[1], 'base64');
  const draft = await store.createDraft({
    ownerId: owner,
    imageBuffer: image,
    mime: 'image/png',
    canvas: { width: 1, height: 1 },
    elements: [{ zIndex: 0, text: '旧文案', x: 0, y: 0, w: 1, h: 1 }],
  });
  await store.saveDraft(owner, draft.id, [{ index: 0, modified: '新文案', alignmentMode: 'center', fontId: 'Poppins/Poppins-Bold.ttf' }]);
  const restored = await store.getDraft(owner, draft.id);
  assert.equal(restored.edits[0].modified, '新文案');
  assert.equal(restored.edits[0].fontId, 'Poppins/Poppins-Bold.ttf');
  assert.equal(await store.getDraft(other, draft.id), null);
  const asset = await store.draftImage(owner, draft.id);
  assert.deepEqual(await readFile(asset.file), image);
});

test('生成结果落盘后可列出、查看、恢复和删除', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'poster-history-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let clock = 10_000;
  const store = createWorkspaceStore({ dataDir, now: () => clock });
  const owner = '33333333-3333-4333-8333-333333333333';
  const image = Buffer.from(PNG_1X1.split(',')[1], 'base64');
  const draft = await store.createDraft({
    ownerId: owner,
    imageBuffer: image,
    mime: 'image/png',
    canvas: { width: 1, height: 1 },
    elements: [{ zIndex: 0, text: 'A', x: 0, y: 0, w: 1, h: 1 }],
    edits: [{ index: 0, modified: 'B' }],
  });
  const started = await store.startHistory({
    ownerId: owner,
    taskId: 'task-1',
    draftId: draft.id,
    imageBuffer: image,
    mime: 'image/png',
    canvas: { width: 1, height: 1 },
    changes: [{ original: 'A', modified: 'B', box: { x: 0, y: 0, w: 1, h: 1 } }],
    provider: 'codex',
  });
  clock = 15_000;
  const completed = await store.completeHistory(owner, started.id, PNG_1X1, 5_000);
  assert.equal(completed.status, 'completed');
  assert.match(completed.resultUrl, /\/api\/history\/.+\/result$/);
  const [summary] = await store.listHistory(owner);
  assert.equal(summary.elapsedMs, 5_000);
  assert.deepEqual(summary.changesPreview, [{ original: 'A', modified: 'B', remove: false }]);
  assert.equal((await store.getHistory(owner, started.id)).changes[0].modified, 'B');
  const result = await store.historyImage(owner, started.id, 'result');
  assert.deepEqual(await readFile(result.file), image);
  const recreated = await store.restoreHistory(owner, started.id);
  assert.equal(recreated.edits[0].modified, 'B');
  assert.equal(await store.deleteHistory(owner, started.id), true);
  assert.equal(await store.getHistory(owner, started.id), null);
});

test('服务重启会把遗留的生成中记录标记为中断失败', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'poster-interrupted-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let clock = 20_000;
  const store = createWorkspaceStore({ dataDir, now: () => clock });
  const owner = '44444444-4444-4444-8444-444444444444';
  const image = Buffer.from(PNG_1X1.split(',')[1], 'base64');
  const started = await store.startHistory({
    ownerId: owner,
    taskId: 'task-interrupted',
    imageBuffer: image,
    mime: 'image/png',
    canvas: { width: 1, height: 1 },
    changes: [{ original: 'A', modified: 'B' }],
    provider: 'codex',
  });
  clock = 25_000;
  assert.equal(await store.markInterruptedHistory(), 1);
  const record = await store.getHistory(owner, started.id);
  assert.equal(record.status, 'failed');
  assert.match(record.error, /服务重启|任务中断/);
  assert.equal(record.elapsedMs, 5_000);
});

test('出图样本不足时使用保守的 5–15 分钟预计区间', () => {
  const estimate = estimateDurationRange([418_000]);
  assert.equal(estimate.minMs, DEFAULT_IMAGE_ESTIMATE.minMs);
  assert.equal(estimate.maxMs, DEFAULT_IMAGE_ESTIMATE.maxMs);
  assert.equal(estimate.samples, 1);
});

test('出图预计区间会从历史成功任务自动校准', () => {
  const log = [
    { status: 'completed', provider: 'codex', elapsedMs: 300_000 },
    { status: 'failed', provider: 'codex', elapsedMs: 900_000 },
    { status: 'completed', provider: 'local', elapsedMs: 1_000 },
    { status: 'completed', provider: 'codex', elapsedMs: 420_000 },
    { status: 'completed', provider: 'codex', elapsedMs: 600_000 },
  ].map(JSON.stringify).join('\n');
  const durations = parseCompletedCodexDurations(`${log}\n{broken`);
  assert.deepEqual(durations, [300_000, 420_000, 600_000]);
  const estimate = estimateDurationRange(durations);
  assert.equal(estimate.samples, 3);
  assert.ok(estimate.minMs < estimate.maxMs);
  assert.ok(estimate.minMs >= 60_000);
  assert.ok(estimate.maxMs <= 25 * 60 * 1000);
});

// ---------- OCR 归一化 ----------

test('四边形顶点转包围盒', () => {
  const box = polygonToBox([
    { X: 10, Y: 20 },
    { X: 190, Y: 22 },
    { X: 188, Y: 52 },
    { X: 12, Y: 50 },
  ]);
  assert.deepEqual(box, { x: 10, y: 20, w: 180, h: 32 });
});

test('空文本、非正宽高、过小区域被过滤', () => {
  const canvas = { width: 1000, height: 1000 };
  const elements = normalizeElements(
    [
      { text: '正常文字', box: { x: 10, y: 10, w: 200, h: 40 } },
      { text: '   ', box: { x: 10, y: 60, w: 200, h: 40 } },
      { text: '宽高非法', box: { x: 10, y: 110, w: 0, h: 40 } },
      { text: '太小', box: { x: 10, y: 160, w: 3, h: 3 } },
    ],
    canvas,
    { minAreaPercent: 0.05 },
  );
  assert.equal(elements.length, 1);
  assert.equal(elements[0].text, '正常文字');
});

test('excludeRects 覆盖的区域被排除', () => {
  const canvas = { width: 1000, height: 1000 };
  const raw = [
    { text: '保留', box: { x: 10, y: 10, w: 200, h: 40 } },
    { text: '排除', box: { x: 500, y: 500, w: 200, h: 40 } },
  ];
  const elements = normalizeElements(raw, canvas, { excludeRects: [{ x: 480, y: 480, w: 300, h: 100 }] });
  assert.deepEqual(elements.map((e) => e.text), ['保留']);
});

test('元素按先上后下、再左后右稳定编号', () => {
  const canvas = { width: 1000, height: 1000 };
  const elements = normalizeElements(
    [
      { text: '下', box: { x: 100, y: 800, w: 200, h: 40 } },
      { text: '上右', box: { x: 600, y: 100, w: 200, h: 40 } },
      { text: '上左', box: { x: 100, y: 100, w: 200, h: 40 } },
    ],
    canvas,
  );
  assert.deepEqual(elements.map((e) => e.text), ['上左', '上右', '下']);
  assert.deepEqual(elements.map((e) => e.zIndex), [0, 1, 2]);
});

// ---------- 同行合并 ----------
// 回归用例：英文按词返回时，一句标题会被拆成多条，且同行差几像素就乱序。

const word = (text, x, y, w = text.length * 30, h = 60) => ({ text, box: { x, y, w, h }, confidence: 99 });

test('同一行的英文单词被合并回一条', () => {
  // 真实场景：阿里云把 "UV GLUE CURING GUIDE" 拆成两条，且 y 差 2px
  const merged = mergeSameLine([word('GLUE CURING GUIDE', 185, 32, 671, 62), word('UV', 84, 34, 115, 59)]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, 'UV GLUE CURING GUIDE', '应按 x 顺序拼接，而不是按 y 排到后面');
  assert.deepEqual(merged[0].box, { x: 84, y: 32, w: 772, h: 62 }, '包围盒取并集');
});

test('分栏排版不会被跨栏合并', () => {
  // 底部三栏标题：同一行，但栏间距远大于字高
  const merged = mergeSameLine([
    word('CLEAR TIPS', 58, 691, 204, 33),
    word('SHEER / JELLY', 329, 690, 223, 34),
    word('DARK OPAQUE', 603, 691, 237, 32),
  ]);
  assert.equal(merged.length, 3, '列间距 ~70px 远超 1.0×行高，不该合并');
  assert.deepEqual(merged.map((m) => m.text), ['CLEAR TIPS', 'SHEER / JELLY', 'DARK OPAQUE']);
});

test('不同行不会被合并', () => {
  const merged = mergeSameLine([word('第一行', 100, 100, 200, 50), word('第二行', 100, 200, 200, 50)]);
  assert.equal(merged.length, 2);
});

test('中日韩之间不加空格，拉丁文之间加空格', () => {
  const cjk = mergeSameLine([word('春季', 100, 100, 100, 50), word('新品', 210, 100, 100, 50)]);
  assert.equal(cjk[0].text, '春季新品', '中文合并不该插入空格');

  const latin = mergeSameLine([word('STRONG', 100, 100, 150, 50), word('CURE', 270, 100, 100, 50)]);
  assert.equal(latin[0].text, 'STRONG CURE');
});

test('合并后置信度取该行最低值', () => {
  const items = [
    { text: 'A', box: { x: 0, y: 0, w: 50, h: 50 }, confidence: 99 },
    { text: 'B', box: { x: 60, y: 0, w: 50, h: 50 }, confidence: 72 },
  ];
  assert.equal(mergeSameLine(items)[0].confidence, 72);
});

test('大字号不会把相邻行吸进来', () => {
  // 一个 120px 的大标题和紧挨着的 20px 小字，中心线相距够远就不该同行
  const merged = mergeSameLine([word('大标题', 100, 0, 400, 120), word('小字注释', 100, 130, 200, 20)]);
  assert.equal(merged.length, 2);
});

test('normalizeElements 默认开启合并，可关闭', () => {
  const canvas = { width: 1000, height: 1000 };
  const raw = [
    { text: 'GLUE', box: { x: 185, y: 32, w: 300, h: 62 } },
    { text: 'UV', box: { x: 84, y: 34, w: 95, h: 59 } },
  ];
  assert.equal(normalizeElements(raw, canvas)[0].text, 'UV GLUE');
  const unmerged = normalizeElements(raw, canvas, { mergeLines: false });
  assert.equal(unmerged.length, 2);
  assert.deepEqual(unmerged.map((e) => e.text), ['UV', 'GLUE'], '不合并时也要按阅读顺序排，不能被 2px 的 y 差带偏');
});

test('竖排文字被识别并据此推算字号', () => {
  const canvas = { width: 1000, height: 1000 };
  const [element] = normalizeElements([{ text: '竖排文字', box: { x: 100, y: 100, w: 40, h: 200 } }], canvas);
  assert.equal(element.isVertical, true);
  assert.equal(element.fontSize, 40, '竖排取宽度作字号');
});
