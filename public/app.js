'use strict';

// 坐标一律以原图像素为准存在 state 里；页面上的框只用百分比定位，
// 所以缩放窗口不会污染提交给后端的坐标（原规格特别强调过这点）。

const POLL_INTERVAL_MS = 1500;
// 后台 Codex 最长运行 25 分钟；页面多留 2 分钟，确保能读到后台的最终成功/失败状态。
const POLL_TIMEOUT_MS = 27 * 60 * 1000;

const state = {
  imageDataUrl: null,
  canvas: null, // {width, height}
  elements: [], // 后端返回的原始识别结果
  edits: new Map(), // zIndex -> {modified, alignmentMode, extraInstruction}
  activeIndex: null,
  taskId: null,
  pollTimer: null,
  pollErrors: 0,
  imageProvider: null,
};

const $ = (id) => document.getElementById(id);

const el = {
  statusChip: $('status-chip'),
  stageUpload: $('stage-upload'),
  stageEdit: $('stage-edit'),
  stageResult: $('stage-result'),
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  preview: $('preview'),
  overlay: $('overlay'),
  canvasInfo: $('canvas-info'),
  listTitle: $('list-title'),
  editCount: $('edit-count'),
  elementList: $('element-list'),
  btnGenerate: $('btn-generate'),
  generateHint: $('generate-hint'),
  btnReset: $('btn-reset'),
  btnBack: $('btn-back'),
  btnDownload: $('btn-download'),
  resultTitle: $('result-title'),
  resultBody: $('result-body'),
  toast: $('toast'),
};

// ---------- 小工具 ----------

let toastTimer = null;
function toast(message, kind = 'error') {
  el.toast.textContent = message;
  el.toast.className = `toast${kind === 'ok' ? ' ok' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 4500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    throw new Error(`服务器返回了非 JSON 响应（HTTP ${response.status}）`);
  }
  if (!response.ok || body.success === false) {
    throw new Error(body?.error ?? `请求失败（HTTP ${response.status}）`);
  }
  return body;
}

function showStage(name) {
  for (const [key, node] of [
    ['upload', el.stageUpload],
    ['edit', el.stageEdit],
    ['result', el.stageResult],
  ]) {
    node.classList.toggle('hidden', key !== name);
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

// ---------- 启动：查服务状态 ----------

async function refreshStatus() {
  try {
    const { ocrProvider, ocrReady, imageProvider, imageReady } = await api('/api/health');
    const ocrLabel = { codex: 'Codex 视觉', mock: '假数据', tencent: '腾讯云', baidu: '百度云' }[ocrProvider] ?? ocrProvider;
    const imageLabel = { local: '本地合成', codex: 'Codex 生图', openai: 'API 生图' }[imageProvider] ?? imageProvider;
    state.imageProvider = imageProvider;
    const warn = ocrProvider === 'mock' || !ocrReady || !imageReady;
    el.statusChip.textContent = `识别 ${ocrLabel} · 出图 ${imageLabel}`;
    el.statusChip.className = `chip ${warn ? 'chip-warn' : 'chip-ok'}`;
    el.statusChip.title = ocrProvider === 'mock' ? '当前是假识别数据，去「设置」填 OCR 密钥' : '';
  } catch (error) {
    el.statusChip.textContent = '服务未就绪';
    el.statusChip.className = 'chip chip-warn';
  }
}

// ---------- 上传 & 识别 ----------

async function handleFile(file) {
  if (!file) return;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    toast('只支持 JPG / PNG / WebP');
    return;
  }
  if (file.size > 12 * 1024 * 1024) {
    toast('图片超过 12MB');
    return;
  }

  el.dropzone.querySelector('.dropzone-title').textContent = '识别中…';
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const { data } = await api('/api/ocr/detect', {
      method: 'POST',
      body: JSON.stringify({ imageBase64: dataUrl }),
    });

    state.imageDataUrl = dataUrl;
    state.canvas = data.canvas;
    state.elements = data.elements;
    state.edits.clear();
    state.activeIndex = null;

    if (!state.elements.length) {
      toast('没有识别到文字，换张图或降低最小区域阈值');
      return;
    }

    el.preview.src = dataUrl;
    el.canvasInfo.textContent = `${data.canvas.width} × ${data.canvas.height} px`;
    el.listTitle.textContent = `识别到 ${state.elements.length} 处文字`;
    renderBoxes();
    renderList();
    updateGenerateState();
    showStage('edit');
  } catch (error) {
    toast(error.message);
  } finally {
    el.dropzone.querySelector('.dropzone-title').textContent = '把海报拖进来，或点击选择';
  }
}

// ---------- 渲染 ----------

function renderBoxes() {
  const { width, height } = state.canvas;
  el.overlay.replaceChildren(
    ...state.elements.map((item) => {
      const box = document.createElement('div');
      box.className = 'box';
      box.dataset.index = String(item.zIndex);
      box.style.left = `${(item.x / width) * 100}%`;
      box.style.top = `${(item.y / height) * 100}%`;
      box.style.width = `${(item.w / width) * 100}%`;
      box.style.height = `${(item.h / height) * 100}%`;

      const tag = document.createElement('span');
      tag.className = 'box-tag';
      tag.textContent = String(item.zIndex + 1);
      box.append(tag);

      box.addEventListener('click', () => focusItem(item.zIndex));
      return box;
    }),
  );
  syncBoxClasses();
}

function renderList() {
  el.elementList.replaceChildren(...state.elements.map(buildItem));
  syncBoxClasses();
}

function buildItem(item) {
  const edit = state.edits.get(item.zIndex) ?? {};
  const node = document.createElement('div');
  node.className = 'item';
  node.dataset.index = String(item.zIndex);

  const head = document.createElement('div');
  head.className = 'item-head';

  const index = document.createElement('span');
  index.className = 'item-index';
  index.textContent = String(item.zIndex + 1);

  const original = document.createElement('div');
  original.className = 'item-original';
  original.textContent = item.text;

  const meta = document.createElement('span');
  meta.className = 'item-meta';
  meta.textContent = [item.isVertical ? '竖排' : null, `${item.fontSize}px`].filter(Boolean).join(' · ');

  head.append(index, original, meta);

  const input = document.createElement('textarea');
  input.rows = item.text.includes('\n') ? 2 : 1;
  input.placeholder = '留空 = 不改这处';
  input.value = edit.modified ?? '';
  input.addEventListener('input', () => {
    setEdit(item.zIndex, { modified: input.value });
  });
  input.addEventListener('focus', () => focusItem(item.zIndex, false));

  const tools = document.createElement('div');
  tools.className = 'item-tools';

  const alignGroup = document.createElement('div');
  alignGroup.className = 'align-group';
  for (const [mode, label] of [
    ['left', '左'],
    ['center', '中'],
    ['right', '右'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = `强制${label}对齐`;
    button.className = edit.alignmentMode === mode ? 'on' : '';
    button.addEventListener('click', () => {
      const current = state.edits.get(item.zIndex)?.alignmentMode;
      setEdit(item.zIndex, { alignmentMode: current === mode ? undefined : mode });
      renderList();
    });
    alignGroup.append(button);
  }

  const extraToggle = document.createElement('button');
  extraToggle.type = 'button';
  extraToggle.className = 'btn btn-ghost btn-sm';
  extraToggle.textContent = edit.extraInstruction ? '调整说明 ✓' : '＋调整说明';

  const extra = document.createElement('input');
  extra.className = 'extra';
  extra.placeholder = '例：向上移动一点、加粗';
  extra.value = edit.extraInstruction ?? '';
  extra.classList.toggle('hidden', !edit.extraInstruction);
  extra.addEventListener('input', () => setEdit(item.zIndex, { extraInstruction: extra.value }));

  extraToggle.addEventListener('click', () => {
    extra.classList.toggle('hidden');
    if (!extra.classList.contains('hidden')) extra.focus();
  });

  tools.append(alignGroup, extraToggle);
  node.append(head, input, tools, extra);
  return node;
}

function focusItem(index, scroll = true) {
  state.activeIndex = index;
  syncBoxClasses();
  if (!scroll) return;
  const target = el.elementList.querySelector(`.item[data-index="${index}"]`);
  if (target) {
    target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    target.querySelector('textarea')?.focus();
  }
}

function syncBoxClasses() {
  for (const box of el.overlay.children) {
    const index = Number(box.dataset.index);
    box.classList.toggle('active', index === state.activeIndex);
    box.classList.toggle('edited', hasEdit(index));
  }
  for (const item of el.elementList.children) {
    const index = Number(item.dataset.index);
    item.classList.toggle('active', index === state.activeIndex);
    item.classList.toggle('edited', hasEdit(index));
  }
}

// ---------- 编辑状态 ----------

function hasEdit(index) {
  const edit = state.edits.get(index);
  if (!edit) return false;
  const modified = (edit.modified ?? '').trim();
  const original = state.elements[index]?.text ?? '';
  return Boolean(modified) && modified !== original;
}

function setEdit(index, patch) {
  const current = state.edits.get(index) ?? {};
  const next = { ...current, ...patch };
  for (const key of Object.keys(next)) if (next[key] === undefined || next[key] === '') delete next[key];
  if (Object.keys(next).length === 0) state.edits.delete(index);
  else state.edits.set(index, next);
  syncBoxClasses();
  updateGenerateState();
}

function collectChanges() {
  const changes = [];
  for (const item of state.elements) {
    if (!hasEdit(item.zIndex)) continue;
    const edit = state.edits.get(item.zIndex);
    changes.push({
      original: item.text,
      modified: edit.modified.trim(),
      alignmentMode: edit.alignmentMode,
      extraInstruction: edit.extraInstruction,
      isVertical: item.isVertical,
      fontSize: item.fontSize,
      // 原图像素坐标，不是页面上量出来的
      box: { x: item.x, y: item.y, w: item.w, h: item.h },
    });
  }
  return changes;
}

function updateGenerateState() {
  const count = collectChanges().length;
  el.btnGenerate.disabled = count === 0;
  el.editCount.textContent = count === 0 ? '未改动' : `已改 ${count} 处`;
  el.editCount.className = `chip ${count === 0 ? 'chip-quiet' : 'chip-ok'}`;
  el.generateHint.textContent = count === 0 ? '改动至少一处文字后可生成' : `将提交 ${count} 处改动`;
}

// ---------- 生成 & 轮询 ----------

async function generate() {
  const changes = collectChanges();
  if (!changes.length) return;

  el.btnGenerate.disabled = true;
  showStage('result');
  el.resultTitle.textContent = '正在生成…';
  el.btnDownload.classList.add('hidden');
  el.resultBody.replaceChildren(spinnerBlock('提交中…'));

  try {
    const { taskId } = await api('/api/ocr/generate', {
      method: 'POST',
      body: JSON.stringify({ imageBase64: state.imageDataUrl, changes }),
    });
    state.taskId = taskId;
    state.pollErrors = 0;
    el.resultBody.replaceChildren(
      spinnerBlock(state.imageProvider === 'codex' ? 'Codex 正在编辑海报，复杂图片通常需要 5–15 分钟…' : '已排队，等待处理…'),
    );
    pollTask(taskId, Date.now() + POLL_TIMEOUT_MS);
  } catch (error) {
    showFailure(error.message);
  } finally {
    el.btnGenerate.disabled = false;
  }
}

function spinnerBlock(text) {
  const wrap = document.createElement('div');
  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = text;
  wrap.append(spinner, note);
  return wrap;
}

function pollTask(taskId, deadline) {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(async () => {
    if (state.taskId !== taskId) return; // 已经开始新任务
    try {
      // 必须先查询后台状态，再判断页面期限。旧逻辑在 12 分钟边界先报超时，
      // 会漏掉刚刚完成的结果。
      const body = await api(`/api/ocr/task/${encodeURIComponent(taskId)}`);
      if (body.status === 'completed') showSuccess(body);
      else if (body.status === 'failed') showFailure(body.error ?? '生成失败');
      else if (Date.now() > deadline) {
        showFailure('页面等待超过 27 分钟，后台任务仍未结束');
      }
      else {
        state.pollErrors = 0;
        const seconds = Math.round((POLL_TIMEOUT_MS - (deadline - Date.now())) / 1000);
        const prefix = state.imageProvider === 'codex' ? 'Codex 生图中' : '处理中';
        el.resultBody.replaceChildren(spinnerBlock(`${prefix}…（已等待 ${seconds}s）`));
        pollTask(taskId, deadline);
      }
    } catch (error) {
      // 短暂断网或服务繁忙不应立刻把仍在运行的任务判成失败。
      state.pollErrors += 1;
      if (Date.now() > deadline) showFailure(`无法取得任务最终状态：${error.message}`);
      else {
        el.resultBody.replaceChildren(spinnerBlock(`连接暂时中断，正在重试…（第 ${state.pollErrors} 次）`));
        pollTask(taskId, deadline);
      }
    }
  }, POLL_INTERVAL_MS);
}

function showSuccess(body) {
  const url = body.data?.[0];
  if (!url) {
    showFailure('任务完成但没有返回图片');
    return;
  }
  el.resultTitle.textContent = '生成完成';

  const compare = document.createElement('div');
  compare.className = 'compare';
  for (const [caption, src] of [
    ['修改前', state.imageDataUrl],
    ['修改后', url],
  ]) {
    const figure = document.createElement('figure');
    const figcaption = document.createElement('figcaption');
    figcaption.textContent = caption;
    const img = document.createElement('img');
    img.src = src;
    img.alt = caption;
    figure.append(figcaption, img);
    compare.append(figure);
  }
  el.resultBody.replaceChildren(compare);

  el.btnDownload.href = url;
  el.btnDownload.classList.remove('hidden');
  toast('生成完成', 'ok');
}

function showFailure(message) {
  clearTimeout(state.pollTimer);
  el.resultTitle.textContent = '生成失败';
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = message;
  el.resultBody.replaceChildren(note);
  toast(message);
}

// ---------- 事件绑定 ----------

el.fileInput.addEventListener('change', (event) => handleFile(event.target.files?.[0]));

for (const type of ['dragenter', 'dragover']) {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.classList.remove('dragging');
  });
}
el.dropzone.addEventListener('drop', (event) => handleFile(event.dataTransfer?.files?.[0]));

el.btnGenerate.addEventListener('click', generate);

el.btnBack.addEventListener('click', () => {
  clearTimeout(state.pollTimer);
  state.taskId = null;
  showStage('edit');
});

el.btnReset.addEventListener('click', () => {
  clearTimeout(state.pollTimer);
  Object.assign(state, { imageDataUrl: null, canvas: null, elements: [], activeIndex: null, taskId: null });
  state.edits.clear();
  el.fileInput.value = '';
  showStage('upload');
});

refreshStatus();
