// 服务入口。路由按原规格 API-CONTRACT.md 挂在 /api 下。

import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import * as configStore from './config.js';
import { createQueue } from './queue.js';
import { createTaskStore } from './task-store.js';
import { createWorkspaceStore, workspaceLimits } from './workspace-store.js';
import { estimateDurationRange, parseCompletedCodexDurations } from './task-metrics.js';
import { parseDetectRequest, parseGenerateRequest, LIMITS } from './validate.js';
import { buildTextEditorPrompt, isRemovalInstruction, validateTemplate, DEFAULT_TEMPLATE } from './prompt.js';
import { describePosition } from './position.js';
import { detectText } from './ocr/index.js';
import { generate } from './image/index.js';
import { isCodexAvailable } from './image/codex.js';
import { measure } from './image/codec.js';
import { makeProbeImage } from './image/probe.js';
import { listFonts, publicFont, resolveFont } from './fonts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1'; // 默认只监听本机，别人从网络上连不进来
const ACCESS_TOKEN = process.env.ACCESS_TOKEN ?? '';
const TASK_EVENT_LOG = path.join(configStore.paths.DATA_DIR, 'task-events.log');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' })); // base64 图片体积上限由 validate.js 精确把关

const taskStore = createTaskStore();
const workspaceStore = createWorkspaceStore({ dataDir: configStore.paths.DATA_DIR });
workspaceStore.markInterruptedHistory().then((count) => {
  if (count) console.log(`[history] 已将 ${count} 条中断任务标记为失败`);
}).catch((error) => console.error('[history] 恢复中断任务状态失败:', error.message));
const limits = configStore.load().limits;
const queue = createQueue({ perUser: limits.perUser, globalMax: limits.globalMax });
let completedCodexDurations = [];
try {
  completedCodexDurations = parseCompletedCodexDurations(readFileSync(TASK_EVENT_LOG, 'utf8'));
} catch {
  // 首次运行还没有日志文件，使用保守默认区间。
}
// 把首次 Codex 可用性扫描放在服务启动阶段，避免用户第一次打开页面时承担扫描耗时。
isCodexAvailable();

// ---------- 身份 ----------
// 单机自用：给每个浏览器发一个 uid cookie 作为归属标识。
// 接入真实认证时，只要把 req.user.id 换成真实用户/租户 id，归属校验逻辑不用动。

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

app.use((req, res, next) => {
  if (ACCESS_TOKEN) {
    const provided = req.headers['x-access-token'] ?? parseCookies(req.headers.cookie).token ?? '';
    if (provided !== ACCESS_TOKEN) {
      return res.status(401).json({ success: false, error: '未认证' });
    }
  }
  const cookies = parseCookies(req.headers.cookie);
  let uid = cookies.uid;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uid ?? '')) {
    uid = randomUUID();
    res.append('Set-Cookie', `uid=${uid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  }
  req.user = { id: uid };
  next();
});

// ---------- 工具 ----------

const ok = (res, data) => res.json({ success: true, ...data });
const fail = (res, status, error) => res.status(status).json({ success: false, error });

async function recordTaskEvent(task, { status, provider, error }) {
  const endedAt = task.completedAt ?? task.failedAt ?? Date.now();
  const event = {
    time: new Date(endedAt).toISOString(),
    taskId: task.id,
    traceId: task.traceId,
    status,
    provider,
    elapsedMs: endedAt - task.createdAt,
    error: error?.message ?? null,
    code: error?.code ?? null,
    diagnostic: error?.diagnostic || null,
  };
  if (status === 'completed' && provider === 'codex' && Number.isFinite(event.elapsedMs)) {
    completedCodexDurations.push(event.elapsedMs);
    completedCodexDurations = completedCodexDurations.slice(-200);
  }
  try {
    await appendFile(TASK_EVENT_LOG, `${JSON.stringify(event)}\n`, 'utf8');
  } catch (logError) {
    console.error('[task-log] 写入失败:', logError.message);
  }
}

/** 统一把 {x,y,w,h} 或 {box:{...}} 归一成 box，并补上 position。 */
function normalizeChanges(changes, canvas) {
  return changes.map((change, index) => {
    const source = change.box ?? change;
    const box = {
      x: Number(source.x),
      y: Number(source.y),
      w: Number(source.w),
      h: Number(source.h),
    };
    const hasBox = Object.values(box).every((n) => Number.isFinite(n)) && box.w > 0 && box.h > 0;
    if (!hasBox) {
      const err = new Error(`第 ${index + 1} 处缺少有效坐标 {x,y,w,h}`);
      err.statusCode = 400;
      throw err;
    }
    const remove = change.remove === true || isRemovalInstruction(change.modified);
    const font = change.fontId ? resolveFont(change.fontId) : null;
    if (change.fontId && !font) {
      const err = new Error(`第 ${index + 1} 处选择的字体不存在，请重新选择`);
      err.statusCode = 400;
      throw err;
    }
    return {
      original: change.original,
      modified: remove ? '' : change.modified,
      remove,
      alignmentMode: change.alignmentMode || undefined,
      extraInstruction: change.extraInstruction || undefined,
      isVertical: change.isVertical === true,
      fontSize: Number(change.fontSize) > 0 ? Number(change.fontSize) : undefined,
      fontId: font?.id,
      fontLabel: font?.label,
      box,
      // 位置描述由原图像素坐标算出，不接受前端传来的缩放后 DOM 坐标
      position: describePosition({ ...box, isVertical: change.isVertical === true }, canvas),
    };
  });
}

function activeTemplate() {
  const stored = configStore.load().prompts.textEditorPrompt;
  return stored?.trim() ? stored : DEFAULT_TEMPLATE;
}

// ---------- OCR ----------

app.post('/api/ocr/detect', async (req, res, next) => {
  try {
    const parsed = parseDetectRequest(req.body);
    if (parsed.error) return fail(res, 400, parsed.error);

    const canvas = await measure(parsed.image.buffer);
    const secrets = configStore.getSecrets();

    const result = await detectText({
      provider: secrets.ocr.provider,
      credentials: secrets.ocr,
      imageBase64Body: parsed.image.buffer.toString('base64'),
      canvas,
      minAreaPercent: parsed.minAreaPercent ?? secrets.ocr.minAreaPercent,
      excludeRects: parsed.excludeRects,
    });

    const draft = await workspaceStore.createDraft({
      ownerId: req.user.id,
      imageBuffer: parsed.image.buffer,
      mime: parsed.image.mime,
      canvas: result.canvas,
      elements: result.elements,
    });

    return ok(res, {
      data: {
        elements: result.elements,
        canvas: result.canvas,
        rawCount: result.rawCount,
        provider: result.provider,
        draftId: draft.id,
      },
    });
  } catch (error) {
    return next(error);
  }
});

// ---------- 生成 ----------

app.post('/api/ocr/generate', async (req, res, next) => {
  try {
    const parsed = parseGenerateRequest(req.body);
    if (parsed.error) return fail(res, 400, parsed.error);

    const secrets = configStore.getSecrets();
    const provider = secrets.image.provider;

    const canvas = await measure(parsed.image.buffer);

    let changes = null;
    let prompt = parsed.prompt;
    if (parsed.changes) {
      changes = normalizeChanges(parsed.changes, canvas);
      prompt = buildTextEditorPrompt({
        canvasSize: `${canvas.width} × ${canvas.height}`,
        changes,
        template: activeTemplate(),
        canvas,
      });
    }
    if (provider === 'local' && !changes) {
      return fail(res, 400, '本地合成需要提交带坐标的 changes');
    }

    // 先占槽位，再建任务。原规格伪代码在这两步之间没有兜底，create 抛异常就泄漏槽位。
    const slot = queue.tryAcquire(req.user.id);
    if (!slot) return fail(res, 429, '并发任务已满，请稍后再试');

    let task;
    let history;
    try {
      task = taskStore.create({
        ownerId: req.user.id,
        prompt,
        action: parsed.action,
        inputImageRef: `${parsed.image.mime}:${parsed.image.buffer.length}B`,
        meta: { provider, canvas },
      });
      history = await workspaceStore.startHistory({
        ownerId: req.user.id,
        taskId: task.id,
        draftId: parsed.draftId,
        imageBuffer: parsed.image.buffer,
        mime: parsed.image.mime,
        canvas,
        changes,
        provider,
      });
    } catch (error) {
      slot.release(); // 建任务失败也必须放掉槽位
      return next(error);
    }

    ok(res, { taskId: task.id, traceId: task.traceId, historyId: history.id });

    // 后台执行，所有异常路径都释放槽位
    (async () => {
      try {
        const out = await generate({
          provider,
          imageBuffer: parsed.image.buffer,
          prompt,
          changes,
          credentials: secrets.image,
        });
        const saved = await workspaceStore.completeHistory(
          req.user.id,
          history.id,
          out.data?.[0],
          Date.now() - task.createdAt,
        );
        const resultUrl = saved?.resultUrl ?? out.data?.[0];
        const completed = taskStore.complete(task.id, [resultUrl], {
          resultMode: saved?.resultUrl ? 'url' : out.resultMode,
          historyId: history.id,
        });
        await recordTaskEvent(completed, { status: 'completed', provider });
        if (out.notes?.length) console.log(`[task ${task.id}] ${out.notes.join(' / ')}`);
      } catch (error) {
        console.error(`[task ${task.id}] 失败:`, error.message);
        const failed = taskStore.fail(task.id, error.message || '任务执行失败');
        await workspaceStore.failHistory(req.user.id, history.id, error.message, Date.now() - task.createdAt);
        await recordTaskEvent(failed, { status: 'failed', provider, error });
      } finally {
        slot.release();
      }
    })();
  } catch (error) {
    return next(error);
  }
});

app.get('/api/ocr/task/:taskId', (req, res) => {
  // 归属校验在 store 内部：不属于当前用户的任务和不存在的任务一样返回 404
  const task = taskStore.get(req.params.taskId, req.user.id);
  if (!task) return fail(res, 404, '任务不存在');
  return res.json(taskStore.toPublic(task));
});

// ---------- 自动保存草稿 ----------

app.get('/api/drafts/latest', async (req, res, next) => {
  try {
    const draft = await workspaceStore.getDraft(req.user.id);
    return ok(res, { draft });
  } catch (error) {
    return next(error);
  }
});

app.put('/api/drafts/:draftId', async (req, res, next) => {
  try {
    const draft = await workspaceStore.saveDraft(req.user.id, req.params.draftId, req.body?.edits ?? []);
    if (!draft) return fail(res, 404, '草稿不存在');
    return ok(res, { draft });
  } catch (error) {
    error.statusCode = error.statusCode ?? 400;
    return next(error);
  }
});

app.delete('/api/drafts/:draftId', async (req, res, next) => {
  try {
    const deleted = await workspaceStore.deleteDraft(req.user.id, req.params.draftId);
    if (!deleted) return fail(res, 404, '草稿不存在');
    return ok(res, { deleted: true });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/drafts/:draftId/image', async (req, res, next) => {
  try {
    const asset = await workspaceStore.draftImage(req.user.id, req.params.draftId);
    if (!asset) return fail(res, 404, '草稿图片不存在');
    res.type(asset.mime);
    res.set('Cache-Control', 'private, max-age=3600');
    return res.sendFile(asset.file);
  } catch (error) {
    return next(error);
  }
});

// ---------- 生成记录 ----------

app.get('/api/history', async (req, res, next) => {
  try {
    return ok(res, { records: await workspaceStore.listHistory(req.user.id), limits: workspaceLimits });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/history/:historyId', async (req, res, next) => {
  try {
    const record = await workspaceStore.getHistory(req.user.id, req.params.historyId);
    if (!record) return fail(res, 404, '生成记录不存在');
    return ok(res, { record });
  } catch (error) {
    return next(error);
  }
});

for (const kind of ['original', 'result']) {
  app.get(`/api/history/:historyId/${kind}`, async (req, res, next) => {
    try {
      const asset = await workspaceStore.historyImage(req.user.id, req.params.historyId, kind);
      if (!asset) return fail(res, 404, '记录图片不存在');
      res.type(asset.mime);
      res.set('Cache-Control', 'private, max-age=3600');
      return res.sendFile(asset.file);
    } catch (error) {
      return next(error);
    }
  });
}

app.post('/api/history/:historyId/restore', async (req, res, next) => {
  try {
    const draft = await workspaceStore.restoreHistory(req.user.id, req.params.historyId);
    if (!draft) return fail(res, 409, '这条记录缺少识别数据，无法继续编辑');
    return ok(res, { draft });
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/history/:historyId', async (req, res, next) => {
  try {
    const deleted = await workspaceStore.deleteHistory(req.user.id, req.params.historyId);
    if (!deleted) return fail(res, 404, '生成记录不存在');
    return ok(res, { deleted: true });
  } catch (error) {
    return next(error);
  }
});

// ---------- 配置 ----------

app.get('/api/ocr-text-edit/config', (req, res) => ok(res, { config: configStore.getPublic() }));

app.put('/api/ocr-text-edit/config', (req, res) => {
  const result = configStore.update(req.body);
  if (result.error) return fail(res, 400, result.error);
  return ok(res, { config: result.config });
});

// 用一张本地生成的测试海报跑一次真实 OCR，验证密钥是否真的可用
app.post('/api/ocr-text-edit/config/test', async (req, res, next) => {
  try {
    const probe = await makeProbeImage();
    const secrets = configStore.getSecrets();
    const started = Date.now();
    const result = await detectText({
      provider: secrets.ocr.provider,
      credentials: secrets.ocr,
      imageBase64Body: probe.buffer.toString('base64'),
      canvas: { width: probe.width, height: probe.height },
      minAreaPercent: 0.05,
      excludeRects: [],
    });
    const found = result.elements.map((el) => el.text);
    const hit = probe.expected.filter((t) => found.some((f) => f.replace(/\s/g, '').includes(t.slice(0, 3))));
    return ok(res, {
      provider: result.provider,
      elapsedMs: Date.now() - started,
      expected: probe.expected,
      found,
      matched: hit.length,
    });
  } catch (error) {
    return next(error);
  }
});

// ---------- 提示词模板 ----------

app.get('/api/product-showcase/prompts', (req, res) =>
  ok(res, {
    textEditorPrompt: configStore.load().prompts.textEditorPrompt,
    defaultTemplate: DEFAULT_TEMPLATE,
    placeholders: ['{{canvasSize}}', '{{changeCount}}', '{{changes}}'],
  }),
);

app.put('/api/product-showcase/prompts', (req, res) => {
  const incoming = req.body?.textEditorPrompt ?? '';
  if (String(incoming).trim() === '') {
    // 显式清空 = 回退到默认模板
    const result = configStore.update({ prompts: { textEditorPrompt: '' } });
    if (result.error) return fail(res, 400, result.error);
    return ok(res, { textEditorPrompt: '', usingDefault: true });
  }
  const checked = validateTemplate(incoming);
  if (checked.error) return fail(res, 400, checked.error);
  const result = configStore.update({ prompts: { textEditorPrompt: checked.template } });
  if (result.error) return fail(res, 400, result.error);
  return ok(res, { textEditorPrompt: checked.template, usingDefault: false });
});

// ---------- 杂项 ----------

app.get('/api/fonts', (req, res) => ok(res, { fonts: listFonts().map(publicFont) }));

app.get('/api/fonts/file', (req, res) => {
  const font = resolveFont(req.query.id);
  if (!font) return fail(res, 404, '字体不存在');
  res.set('Cache-Control', 'private, max-age=3600');
  return res.sendFile(font.path);
});

app.get('/api/health', (req, res) => {
  const c = configStore.getPublic();
  const codexAvailable = isCodexAvailable();
  return ok(res, {
    ocrProvider: c.ocr.provider,
    ocrReady:
      c.ocr.provider === 'mock' ||
      (c.ocr.provider === 'codex' && codexAvailable) ||
      c.ocr.hasCredentials,
    imageProvider: c.image.provider,
    imageReady:
      c.image.provider === 'local' ||
      (c.image.provider === 'codex' && codexAvailable) ||
      (c.image.provider === 'openai' && c.image.hasApiKey),
    codexAvailable,
    imageEstimate: estimateDurationRange(completedCodexDurations),
    limits: LIMITS,
    queue: queue.stats(),
    tasks: taskStore.size(),
  });
});

app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

// 兜底错误处理：日志留详情，响应只给可安全展示的信息
app.use((error, req, res, next) => {
  const status = error.statusCode ?? 500;
  if (status >= 500) console.error('[error]', error);
  if (res.headersSent) return next(error);
  return fail(res, status, error.message || '服务内部错误');
});

app.listen(PORT, HOST, () => {
  const c = configStore.getPublic();
  console.log(`\n  海报文案修改  →  http://${HOST}:${PORT}\n`);
  console.log(`  文字识别: ${c.ocr.provider}${c.ocr.provider === 'mock' ? '（假数据，去配置页填密钥）' : ''}`);
  console.log(`  出图方式: ${c.image.provider}${c.image.provider === 'local' ? '（本地合成，无需密钥）' : ''}`);
  console.log(`  配置页:   http://${HOST}:${PORT}/config.html\n`);
});

export { app };
