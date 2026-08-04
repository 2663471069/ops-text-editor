import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';

const RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECORDS_PER_OWNER = 50;
const MIME_EXTENSION = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);
const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertId(value, label) {
  if (!UUID.test(String(value ?? ''))) throw new Error(`${label} 格式无效`);
  return String(value);
}

function extensionFor(mime) {
  const extension = MIME_EXTENSION.get(String(mime).toLowerCase());
  if (!extension) throw new Error(`不支持保存的图片类型 ${mime}`);
  return extension;
}

function safeEdits(edits) {
  if (!Array.isArray(edits)) throw new Error('草稿 edits 必须是数组');
  if (edits.length > 200) throw new Error('草稿修改数量过多');
  return edits.map((entry) => {
    const index = Number(entry?.index);
    if (!Number.isInteger(index) || index < 0 || index > 10_000) throw new Error('草稿修改序号无效');
    const out = { index };
    for (const [key, max] of [['modified', 200], ['extraInstruction', 200], ['fontId', 300]]) {
      if (entry?.[key] === undefined || entry?.[key] === '') continue;
      const value = String(entry[key]);
      if (value.length > max) throw new Error(`${key} 超过 ${max} 字上限`);
      out[key] = value;
    }
    if (entry?.alignmentMode !== undefined) {
      if (!['left', 'center', 'right'].includes(entry.alignmentMode)) throw new Error('对齐方式无效');
      out.alignmentMode = entry.alignmentMode;
    }
    return out;
  });
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function publicDraft(record) {
  return {
    id: record.id,
    canvas: record.canvas,
    elements: record.elements,
    edits: record.edits ?? [],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    imageUrl: `/api/drafts/${record.id}/image?v=${record.updatedAt}`,
  };
}

function publicHistory(record, { detail = false } = {}) {
  const changes = Array.isArray(record.changes) ? record.changes : [];
  const base = {
    id: record.id,
    status: record.status,
    provider: record.provider,
    changeCount: changes.length,
    changesPreview: changes.slice(0, 3).map((change) => {
      const preview = {
        original: String(change.original ?? ''),
        modified: change.remove === true ? '' : String(change.modified ?? ''),
        remove: change.remove === true,
      };
      if (change.fontLabel) preview.fontLabel = change.fontLabel;
      return preview;
    }),
    createdAt: record.createdAt,
    completedAt: record.completedAt ?? null,
    failedAt: record.failedAt ?? null,
    elapsedMs: record.elapsedMs ?? null,
    error: record.error ?? null,
    originalUrl: `/api/history/${record.id}/original`,
    resultUrl: record.resultFile ? `/api/history/${record.id}/result` : record.resultUrl ?? null,
    canRestore: Array.isArray(record.elements) && record.elements.length > 0,
  };
  if (detail) {
    base.canvas = record.canvas;
    base.changes = changes;
  }
  return base;
}

export function createWorkspaceStore({ dataDir, now = () => Date.now() }) {
  const root = path.join(dataDir, 'workspace');
  const draftsRoot = path.join(root, 'drafts');
  const historyRoot = path.join(root, 'history');

  const ownerDraftDir = (ownerId) => path.join(draftsRoot, assertId(ownerId, '用户标识'));
  const ownerHistoryDir = (ownerId) => path.join(historyRoot, assertId(ownerId, '用户标识'));
  const recordDir = (ownerId, id) => path.join(ownerHistoryDir(ownerId), assertId(id, '记录标识'));

  async function getDraftRecord(ownerId) {
    const file = path.join(ownerDraftDir(ownerId), 'draft.json');
    if (!(await exists(file))) return null;
    try {
      const record = await readJson(file);
      return record.ownerId === ownerId ? record : null;
    } catch {
      return null;
    }
  }

  async function createDraft({ ownerId, imageBuffer, mime, canvas, elements, edits = [] }) {
    const dir = ownerDraftDir(ownerId);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const timestamp = now();
    const id = randomUUID();
    const originalFile = `original.${extensionFor(mime)}`;
    await writeFile(path.join(dir, originalFile), imageBuffer, { mode: 0o600 });
    const record = {
      id,
      ownerId,
      mime,
      originalFile,
      canvas,
      elements,
      edits: safeEdits(edits),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await writeJsonAtomic(path.join(dir, 'draft.json'), record);
    return publicDraft(record);
  }

  async function getDraft(ownerId, expectedId = null) {
    const record = await getDraftRecord(ownerId);
    if (!record || (expectedId && record.id !== expectedId)) return null;
    return publicDraft(record);
  }

  async function getDraftInternal(ownerId, expectedId = null) {
    const record = await getDraftRecord(ownerId);
    if (!record || (expectedId && record.id !== expectedId)) return null;
    return record;
  }

  async function saveDraft(ownerId, id, edits) {
    const record = await getDraftRecord(ownerId);
    if (!record || record.id !== id) return null;
    record.edits = safeEdits(edits);
    record.updatedAt = now();
    await writeJsonAtomic(path.join(ownerDraftDir(ownerId), 'draft.json'), record);
    return publicDraft(record);
  }

  async function deleteDraft(ownerId, id = null) {
    const record = await getDraftRecord(ownerId);
    if (!record || (id && record.id !== id)) return false;
    await rm(ownerDraftDir(ownerId), { recursive: true, force: true });
    return true;
  }

  async function draftImage(ownerId, id) {
    const record = await getDraftRecord(ownerId);
    if (!record || record.id !== id) return null;
    return { file: path.join(ownerDraftDir(ownerId), record.originalFile), mime: record.mime };
  }

  async function cleanupHistory(ownerId) {
    const dir = ownerHistoryDir(ownerId);
    if (!(await exists(dir))) return;
    const ids = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && UUID.test(entry.name));
    const records = [];
    for (const entry of ids) {
      try {
        const record = await readJson(path.join(dir, entry.name, 'record.json'));
        records.push({ id: entry.name, createdAt: Number(record.createdAt) || 0 });
      } catch {
        records.push({ id: entry.name, createdAt: 0 });
      }
    }
    records.sort((a, b) => b.createdAt - a.createdAt);
    const cutoff = now() - RECORD_TTL_MS;
    const stale = records.filter((record, index) => index >= MAX_RECORDS_PER_OWNER || record.createdAt < cutoff);
    await Promise.all(stale.map((record) => rm(path.join(dir, record.id), { recursive: true, force: true })));
  }

  async function startHistory({ ownerId, taskId, draftId, imageBuffer, mime, canvas, changes, provider }) {
    const id = randomUUID();
    const dir = recordDir(ownerId, id);
    await mkdir(dir, { recursive: true });
    const originalFile = `original.${extensionFor(mime)}`;
    await writeFile(path.join(dir, originalFile), imageBuffer, { mode: 0o600 });
    const draft = draftId ? await getDraftRecord(ownerId) : null;
    const hasMatchingDraft = Boolean(draft && draft.id === draftId);
    const record = {
      id,
      ownerId,
      taskId,
      draftId: hasMatchingDraft ? draftId : null,
      status: 'processing',
      provider,
      mime,
      originalFile,
      canvas,
      elements: hasMatchingDraft ? draft.elements : null,
      edits: hasMatchingDraft ? draft.edits : [],
      changes,
      createdAt: now(),
      completedAt: null,
      failedAt: null,
      elapsedMs: null,
      error: null,
      resultFile: null,
      resultUrl: null,
    };
    await writeJsonAtomic(path.join(dir, 'record.json'), record);
    cleanupHistory(ownerId).catch((error) => console.error('[history] 清理失败:', error.message));
    return publicHistory(record, { detail: true });
  }

  async function loadHistoryRecord(ownerId, id) {
    try {
      const record = await readJson(path.join(recordDir(ownerId, id), 'record.json'));
      return record.ownerId === ownerId ? record : null;
    } catch {
      return null;
    }
  }

  async function completeHistory(ownerId, id, resultValue, elapsedMs) {
    const record = await loadHistoryRecord(ownerId, id);
    if (!record) return null;
    const match = typeof resultValue === 'string' ? DATA_URL.exec(resultValue) : null;
    if (match) {
      const mime = match[1].toLowerCase();
      record.resultFile = `result.${extensionFor(mime)}`;
      await writeFile(path.join(recordDir(ownerId, id), record.resultFile), Buffer.from(match[2], 'base64'), { mode: 0o600 });
      record.resultMime = mime;
      record.resultUrl = null;
    } else if (/^https?:\/\//i.test(String(resultValue ?? ''))) {
      record.resultUrl = String(resultValue);
    } else {
      throw new Error('生成结果不是可保存的图片');
    }
    record.status = 'completed';
    record.completedAt = now();
    record.elapsedMs = Number(elapsedMs) || record.completedAt - record.createdAt;
    await writeJsonAtomic(path.join(recordDir(ownerId, id), 'record.json'), record);
    return publicHistory(record, { detail: true });
  }

  async function failHistory(ownerId, id, error, elapsedMs) {
    const record = await loadHistoryRecord(ownerId, id);
    if (!record) return null;
    record.status = 'failed';
    record.error = String(error || '生成失败').slice(0, 500);
    record.failedAt = now();
    record.elapsedMs = Number(elapsedMs) || record.failedAt - record.createdAt;
    await writeJsonAtomic(path.join(recordDir(ownerId, id), 'record.json'), record);
    return publicHistory(record, { detail: true });
  }

  async function listHistory(ownerId) {
    await cleanupHistory(ownerId);
    const dir = ownerHistoryDir(ownerId);
    if (!(await exists(dir))) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    const records = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const record = await loadHistoryRecord(ownerId, entry.name);
      if (record) records.push(publicHistory(record));
    }
    return records.sort((a, b) => b.createdAt - a.createdAt);
  }

  async function getHistory(ownerId, id) {
    const record = await loadHistoryRecord(ownerId, id);
    return record ? publicHistory(record, { detail: true }) : null;
  }

  async function historyImage(ownerId, id, kind) {
    const record = await loadHistoryRecord(ownerId, id);
    if (!record) return null;
    if (kind === 'original') return { file: path.join(recordDir(ownerId, id), record.originalFile), mime: record.mime };
    if (kind === 'result' && record.resultFile) {
      return { file: path.join(recordDir(ownerId, id), record.resultFile), mime: record.resultMime };
    }
    return null;
  }

  async function deleteHistory(ownerId, id) {
    const record = await loadHistoryRecord(ownerId, id);
    if (!record) return false;
    await rm(recordDir(ownerId, id), { recursive: true, force: true });
    return true;
  }

  async function restoreHistory(ownerId, id) {
    const record = await loadHistoryRecord(ownerId, id);
    if (!record || !Array.isArray(record.elements) || record.elements.length === 0) return null;
    const source = path.join(recordDir(ownerId, id), record.originalFile);
    const buffer = await readFile(source);
    return createDraft({
      ownerId,
      imageBuffer: buffer,
      mime: record.mime,
      canvas: record.canvas,
      elements: record.elements,
      edits: record.edits ?? [],
    });
  }

  async function markInterruptedHistory() {
    if (!(await exists(historyRoot))) return 0;
    const owners = (await readdir(historyRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && UUID.test(entry.name));
    let updated = 0;
    for (const owner of owners) {
      const entries = await readdir(path.join(historyRoot, owner.name), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
        const record = await loadHistoryRecord(owner.name, entry.name);
        if (!record || record.status !== 'processing') continue;
        record.status = 'failed';
        record.error = '服务重启或任务中断，未能取得生成结果';
        record.failedAt = now();
        record.elapsedMs = Math.max(0, record.failedAt - record.createdAt);
        await writeJsonAtomic(path.join(recordDir(owner.name, entry.name), 'record.json'), record);
        updated += 1;
      }
    }
    return updated;
  }

  return {
    createDraft,
    getDraft,
    getDraftInternal,
    saveDraft,
    deleteDraft,
    draftImage,
    startHistory,
    completeHistory,
    failHistory,
    listHistory,
    getHistory,
    historyImage,
    deleteHistory,
    restoreHistory,
    markInterruptedHistory,
  };
}

export const workspaceLimits = { recordTtlMs: RECORD_TTL_MS, maxRecordsPerOwner: MAX_RECORDS_PER_OWNER };
