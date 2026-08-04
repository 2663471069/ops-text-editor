'use strict';

const $ = (id) => document.getElementById(id);
const content = $('history-content');
const retention = $('history-retention');
const toastNode = $('toast');
let toastTimer = null;

function toast(message, kind = 'error') {
  toastNode.textContent = message;
  toastNode.className = `toast${kind === 'ok' ? ' ok' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.add('hidden'), 4000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success === false) throw new Error(body?.error ?? `请求失败（HTTP ${response.status}）`);
  return body;
}

function formatTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(value));
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '—';
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function statusLabel(status) {
  return { processing: '生成中', completed: '已完成', failed: '失败' }[status] ?? status;
}

function button(label, className, handler) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  node.addEventListener('click', handler);
  return node;
}

function historyCard(record) {
  const card = document.createElement('article');
  card.className = 'history-card';

  const preview = document.createElement('img');
  preview.className = 'history-thumb';
  preview.src = record.resultUrl || record.originalUrl;
  preview.alt = record.status === 'completed' ? '生成结果缩略图' : '原图缩略图';
  preview.loading = 'lazy';
  preview.dataset.zoomable = 'true';
  preview.title = '点击放大查看';

  const body = document.createElement('div');
  body.className = 'history-card-body';
  const top = document.createElement('div');
  top.className = 'history-card-top';
  const title = document.createElement('strong');
  title.textContent = `${record.changeCount} 处文案修改`;
  const status = document.createElement('span');
  status.className = `chip history-status ${record.status}`;
  status.textContent = statusLabel(record.status);
  top.append(title, status);

  const meta = document.createElement('p');
  meta.className = 'muted small history-meta';
  meta.textContent = `${formatTime(record.createdAt)} · 用时 ${formatDuration(record.elapsedMs)} · ${record.provider ?? '未知方式'}`;
  body.append(top, meta);

  if (record.error) {
    const error = document.createElement('p');
    error.className = 'history-error small';
    error.textContent = record.error;
    body.append(error);
  }

  const actions = document.createElement('div');
  actions.className = 'history-actions';
  actions.append(button('查看对比', 'btn btn-ghost btn-sm', () => showDetail(record.id)));
  if (record.canRestore) actions.append(button('继续编辑', 'btn btn-ghost btn-sm', () => restore(record.id)));
  if (record.resultUrl) {
    const download = document.createElement('a');
    download.className = 'btn btn-ghost btn-sm';
    download.textContent = '下载';
    download.href = record.resultUrl;
    download.download = `poster-${record.id.slice(0, 8)}.jpg`;
    actions.append(download);
  }
  actions.append(button('删除', 'btn btn-danger btn-sm', () => removeRecord(record.id)));
  body.append(actions);
  card.append(preview, body);
  return card;
}

async function loadHistory() {
  content.innerHTML = '<div class="history-empty"><div class="spinner"></div><p class="muted">读取记录中…</p></div>';
  try {
    const { records, limits } = await api('/api/history');
    retention.textContent = `只保存在这台电脑上 · 最多 ${limits.maxRecordsPerOwner} 条 · 保留 30 天`;
    if (!records.length) {
      content.innerHTML = '<div class="history-empty"><p>还没有生成记录</p><a class="btn btn-primary history-start" href="index.html">去修改一张海报</a></div>';
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'history-grid';
    grid.replaceChildren(...records.map(historyCard));
    content.replaceChildren(grid);
  } catch (error) {
    content.innerHTML = `<div class="history-empty"><p>读取失败：${escapeHtml(error.message)}</p></div>`;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

async function showDetail(id) {
  content.innerHTML = '<div class="history-empty"><div class="spinner"></div><p class="muted">读取详情中…</p></div>';
  try {
    const { record } = await api(`/api/history/${encodeURIComponent(id)}`);
    const detail = document.createElement('section');
    detail.className = 'history-detail';
    const head = document.createElement('div');
    head.className = 'history-detail-head';
    const heading = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = `${record.changeCount} 处文案修改 · ${statusLabel(record.status)}`;
    const meta = document.createElement('p');
    meta.className = 'muted small';
    meta.textContent = `${formatTime(record.createdAt)} · 用时 ${formatDuration(record.elapsedMs)}`;
    heading.append(title, meta);
    head.append(heading, button('返回记录', 'btn btn-ghost', loadHistory));

    const compare = document.createElement('div');
    compare.className = 'compare history-compare';
    for (const [caption, src] of [['修改前', record.originalUrl], ['修改后', record.resultUrl]]) {
      if (!src) continue;
      const figure = document.createElement('figure');
      const label = document.createElement('figcaption');
      label.textContent = caption;
      const image = document.createElement('img');
      image.src = src;
      image.alt = caption;
      image.dataset.zoomable = 'true';
      image.title = '点击放大查看';
      figure.append(label, image);
      compare.append(figure);
    }

    const changes = document.createElement('div');
    changes.className = 'history-changes';
    const changesTitle = document.createElement('h3');
    changesTitle.textContent = '文案变更';
    changes.append(changesTitle);
    for (const change of record.changes ?? []) {
      const row = document.createElement('div');
      row.className = 'history-change';
      const before = document.createElement('span');
      before.textContent = change.original;
      const arrow = document.createElement('span');
      arrow.className = 'muted';
      arrow.textContent = '→';
      const after = document.createElement('strong');
      after.textContent = change.remove ? '清除该范围文字' : change.modified;
      row.append(before, arrow, after);
      changes.append(row);
    }

    const actions = document.createElement('div');
    actions.className = 'history-actions detail-actions';
    if (record.canRestore) actions.append(button('继续编辑', 'btn btn-primary', () => restore(record.id)));
    if (record.resultUrl) {
      const download = document.createElement('a');
      download.className = 'btn btn-ghost';
      download.textContent = '下载生成图';
      download.href = record.resultUrl;
      download.download = `poster-${record.id.slice(0, 8)}.jpg`;
      actions.append(download);
    }
    detail.append(head, compare, changes, actions);
    content.replaceChildren(detail);
  } catch (error) {
    toast(error.message);
    loadHistory();
  }
}

async function restore(id) {
  try {
    await api(`/api/history/${encodeURIComponent(id)}/restore`, { method: 'POST', body: '{}' });
    location.href = 'index.html';
  } catch (error) {
    toast(error.message);
  }
}

async function removeRecord(id) {
  if (!confirm('确定删除这条生成记录吗？原图和结果图都会从本机删除。')) return;
  try {
    await api(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('记录已删除', 'ok');
    await loadHistory();
  } catch (error) {
    toast(error.message);
  }
}

$('btn-refresh-history').addEventListener('click', loadHistory);
loadHistory();
