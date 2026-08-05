'use strict';

// 坐标一律以原图像素为准存在 state 里；页面上的框只用百分比定位，
// 所以缩放窗口不会污染提交给后端的坐标（原规格特别强调过这点）。

const POLL_INTERVAL_MS = 1500;
// 后台 Codex 最长运行 25 分钟；页面多留 2 分钟，确保能读到后台的最终成功/失败状态。
const POLL_TIMEOUT_MS = 27 * 60 * 1000;
const REMOVAL_KEYWORDS = new Set(['消除', '删除', '去除', '清除']);
const DROPZONE_DEFAULT_TITLE = '把海报拖进来、点击选择或直接粘贴';

const state = {
  imageDataUrl: null,
  draftId: null,
  canvas: null, // {width, height}
  elements: [], // 后端返回的原始识别结果
  edits: new Map(), // zIndex -> {modified, alignmentMode, extraInstruction}
  activeIndex: null,
  taskId: null,
  pollTimer: null,
  pollErrors: 0,
  imageProvider: null,
  imageEstimate: { minMs: 5 * 60 * 1000, maxMs: 15 * 60 * 1000, samples: 0 },
  fonts: [],
  elementFilter: 'all',
  elementSearch: '',
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
  btnZoom: $('btn-zoom'),
  overlay: $('overlay'),
  canvasInfo: $('canvas-info'),
  listTitle: $('list-title'),
  editCount: $('edit-count'),
  elementList: $('element-list'),
  elementSearch: $('element-search'),
  elementFilters: $('element-filters'),
  elementEmpty: $('element-empty'),
  filterAllCount: $('filter-all-count'),
  filterEditedCount: $('filter-edited-count'),
  filterUneditedCount: $('filter-unedited-count'),
  batchFont: $('batch-font'),
  btnApplyFont: $('btn-apply-font'),
  changeLog: $('change-log'),
  changeLogCount: $('change-log-count'),
  changeLogList: $('change-log-list'),
  btnGenerate: $('btn-generate'),
  generationSummary: $('generation-summary'),
  generationMeta: $('generation-meta'),
  generateHint: $('generate-hint'),
  btnReset: $('btn-reset'),
  btnBack: $('btn-back'),
  btnNext: $('btn-next'),
  btnDownload: $('btn-download'),
  resultTitle: $('result-title'),
  resultBody: $('result-body'),
  toast: $('toast'),
  draftStatus: $('draft-status'),
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

async function imageUrlAsDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('读取已保存的草稿图片失败');
  return readFileAsDataUrl(await response.blob());
}

function fontById(fontId) {
  return state.fonts.find((font) => font.id === fontId) ?? null;
}

function populateFontOptions(select, { placeholder = '字体：自动保留原样', selected = '' } = {}) {
  const groups = new Map();
  select.replaceChildren(new Option(placeholder, ''));
  for (const [fontIndex, font] of state.fonts.entries()) {
    let group = groups.get(font.family);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = font.family;
      groups.set(font.family, group);
      select.append(group);
    }
    const option = new Option(font.label, font.id);
    option.style.fontFamily = `CompanyPreview${fontIndex}`;
    group.append(option);
  }
  select.value = selected;
  select.dataset.populated = 'true';
}

function generationEstimateLabel() {
  if (state.imageProvider === 'local') return '本地合成 · 通常数秒完成';
  if (state.imageProvider === 'codex') {
    return `Codex 生图 · 预计 ${formatDuration(state.imageEstimate.minMs)}–${formatDuration(state.imageEstimate.maxMs)}`;
  }
  if (state.imageProvider === 'openai') return 'API 生图 · 时间取决于服务商';
  return '正在读取出图方式…';
}

function updateGenerationMeta() {
  if (el.generationMeta) el.generationMeta.textContent = generationEstimateLabel();
}

// ---------- 启动：查服务状态 ----------

async function refreshStatus() {
  try {
    const { ocrProvider, ocrReady, imageProvider, imageReady, imageEstimate } = await api('/api/health');
    const ocrLabel = { codex: 'Codex 视觉', mock: '假数据', tencent: '腾讯云', baidu: '百度云' }[ocrProvider] ?? ocrProvider;
    const imageLabel = { local: '本地合成', codex: 'Codex 生图', openai: 'API 生图' }[imageProvider] ?? imageProvider;
    state.imageProvider = imageProvider;
    if (imageEstimate) state.imageEstimate = imageEstimate;
    updateGenerationMeta();
    const warn = ocrProvider === 'mock' || !ocrReady || !imageReady;
    el.statusChip.textContent = `识别 ${ocrLabel} · 出图 ${imageLabel}`;
    el.statusChip.className = `chip ${warn ? 'chip-warn' : 'chip-ok'}`;
    el.statusChip.title = ocrProvider === 'mock' ? '当前是假识别数据，去「设置」填 OCR 密钥' : '';
  } catch (error) {
    el.statusChip.textContent = '服务未就绪';
    el.statusChip.className = 'chip chip-warn';
  }
}

async function refreshFonts() {
  try {
    const { fonts } = await api('/api/fonts');
    state.fonts = fonts ?? [];
    const style = document.createElement('style');
    style.dataset.companyFonts = 'true';
    style.textContent = state.fonts.map((font, index) =>
      `@font-face{font-family:"CompanyPreview${index}";src:url("${font.url}");font-display:swap}`
    ).join('\n');
    document.head.querySelector('style[data-company-fonts]')?.remove();
    document.head.append(style);
    populateFontOptions(el.batchFont, { placeholder: '批量字体：自动保留原样' });
  } catch (error) {
    console.warn('[fonts] 加载失败:', error.message);
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

  el.dropzone.classList.add('processing');
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
    state.draftId = data.draftId;
    state.edits.clear();
    state.activeIndex = null;

    if (!state.elements.length) {
      toast('没有识别到文字，换张图或降低最小区域阈值');
      return;
    }

    el.preview.src = dataUrl;
    el.canvasInfo.textContent = `${data.canvas.width} × ${data.canvas.height} px`;
    el.listTitle.textContent = `识别到 ${state.elements.length} 处文字`;
    resetListView();
    renderBoxes();
    renderList();
    updateGenerateState();
    showStage('edit');
    setDraftStatus('已自动保存', 'ok');
  } catch (error) {
    toast(error.message);
  } finally {
    el.dropzone.classList.remove('processing');
    el.dropzone.querySelector('.dropzone-title').textContent = DROPZONE_DEFAULT_TITLE;
  }
}

function clipboardImage(clipboardData) {
  const files = [...(clipboardData?.files ?? [])];
  const direct = files.find((file) => /^image\//i.test(file.type));
  if (direct) return direct;
  for (const item of clipboardData?.items ?? []) {
    if (item.kind !== 'file' || !/^image\//i.test(item.type)) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

function isTextEditingTarget(target) {
  return target instanceof HTMLElement && (
    target.isContentEditable ||
    target.matches('input, textarea, select')
  );
}

async function handlePaste(event) {
  const file = clipboardImage(event.clipboardData);
  if (!file || isTextEditingTarget(event.target)) return;
  event.preventDefault();

  if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) {
    toast('剪贴板图片格式不支持，请使用 JPG、PNG 或 WebP');
    return;
  }
  if (file.size > 12 * 1024 * 1024) {
    toast('剪贴板图片超过 12MB');
    return;
  }

  const generationRunning = !el.stageResult.classList.contains('hidden') && el.btnNext.classList.contains('hidden');
  if (generationRunning) {
    toast('当前图片正在生成，请等待完成后再粘贴下一张');
    return;
  }

  if (state.imageDataUrl) {
    const confirmed = window.confirm('粘贴新图片会结束当前编辑并切换到新图片，已生成的历史记录不会删除。是否继续？');
    if (!confirmed) return;
    await startNewPoster();
  }

  await handleFile(file);
}

// ---------- 渲染 ----------

function renderBoxes() {
  const { width, height } = state.canvas;
  el.overlay.replaceChildren(
    ...state.elements.map((item) => {
      const box = document.createElement('div');
      box.className = 'box';
      box.dataset.index = String(item.zIndex);
      box.tabIndex = 0;
      box.setAttribute('role', 'button');
      box.setAttribute('aria-label', `编辑第 ${item.zIndex + 1} 处：${item.text}`);
      box.style.left = `${(item.x / width) * 100}%`;
      box.style.top = `${(item.y / height) * 100}%`;
      box.style.width = `${(item.w / width) * 100}%`;
      box.style.height = `${(item.h / height) * 100}%`;

      const tag = document.createElement('span');
      tag.className = 'box-tag';
      tag.textContent = String(item.zIndex + 1);
      box.append(tag);

      box.addEventListener('click', () => focusItem(item.zIndex));
      box.addEventListener('keydown', (event) => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        focusItem(item.zIndex);
      });
      return box;
    }),
  );
  syncBoxClasses();
}

function renderList() {
  el.elementList.replaceChildren(...state.elements.map(buildItem));
  syncBoxClasses();
  applyListView();
}

function compact(value) {
  return String(value ?? '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function itemMatchesView(item) {
  const focusedItem = document.activeElement?.closest?.('.item');
  if (Number(focusedItem?.dataset.index) === item.zIndex) return true;
  const edited = hasEdit(item.zIndex);
  if (state.elementFilter === 'edited' && !edited) return false;
  if (state.elementFilter === 'unedited' && edited) return false;
  if (!state.elementSearch) return true;
  const edit = state.edits.get(item.zIndex);
  return compact(`${item.text} ${edit?.modified ?? ''}`).includes(state.elementSearch);
}

function applyListView() {
  const editedCount = state.elements.filter((item) => hasEdit(item.zIndex)).length;
  el.filterAllCount.textContent = String(state.elements.length);
  el.filterEditedCount.textContent = String(editedCount);
  el.filterUneditedCount.textContent = String(state.elements.length - editedCount);
  el.btnApplyFont.disabled = editedCount === 0;

  for (const button of el.elementFilters.querySelectorAll('button[data-filter]')) {
    const on = button.dataset.filter === state.elementFilter;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  }

  let visibleCount = 0;
  for (const item of state.elements) {
    const node = el.elementList.querySelector(`.item[data-index="${item.zIndex}"]`);
    if (!node) continue;
    const visible = itemMatchesView(item);
    node.classList.toggle('filtered-out', !visible);
    if (visible) visibleCount += 1;
  }
  el.elementEmpty.classList.toggle('hidden', visibleCount !== 0 || state.elements.length === 0);
}

function resetListView() {
  state.elementFilter = 'all';
  state.elementSearch = '';
  el.elementSearch.value = '';
  applyListView();
}

function createLazyFontSelect(item, input) {
  const select = document.createElement('select');
  select.className = 'font-select';
  select.title = '选择公司字体；不选择时由 AI 保留原字体';

  const showCurrent = () => {
    const fontId = state.edits.get(item.zIndex)?.fontId ?? '';
    const font = fontById(fontId);
    select.replaceChildren(new Option(font ? font.label : '字体：自动保留原样', fontId));
    select.value = fontId;
    select.dataset.populated = 'false';
  };
  const ensureOptions = () => {
    if (select.dataset.populated === 'true') return;
    populateFontOptions(select, { selected: state.edits.get(item.zIndex)?.fontId ?? '' });
  };
  const applyPreview = () => {
    const fontIndex = state.fonts.findIndex((font) => font.id === (state.edits.get(item.zIndex)?.fontId ?? ''));
    input.style.fontFamily = fontIndex >= 0 ? `CompanyPreview${fontIndex}` : '';
  };

  showCurrent();
  applyPreview();
  select.addEventListener('pointerdown', ensureOptions);
  select.addEventListener('focus', ensureOptions);
  select.addEventListener('change', () => {
    setEdit(item.zIndex, { fontId: select.value || undefined });
    applyPreview();
  });
  select.refresh = () => {
    const fontId = state.edits.get(item.zIndex)?.fontId ?? '';
    if (select.dataset.populated === 'true') select.value = fontId;
    else showCurrent();
    applyPreview();
  };
  return select;
}

function buildItem(item) {
  const edit = state.edits.get(item.zIndex) ?? {};
  const node = document.createElement('div');
  node.className = 'item';
  node.dataset.index = String(item.zIndex);
  node.addEventListener('focusout', () => setTimeout(applyListView, 0));

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
  input.placeholder = '输入新文案；输入“消除”可清除该范围';
  input.value = edit.modified ?? '';
  input.addEventListener('input', () => {
    setEdit(item.zIndex, { modified: input.value });
  });
  input.addEventListener('focus', () => focusItem(item.zIndex, false));

  const tools = document.createElement('div');
  tools.className = 'item-tools';

  const fontSelect = createLazyFontSelect(item, input);

  const alignGroup = document.createElement('div');
  alignGroup.className = 'align-group';
  for (const [mode, label] of [
    ['left', '左'],
    ['center', '中'],
    ['right', '右'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.mode = mode;
    button.textContent = label;
    button.title = `强制${label}对齐`;
    button.className = edit.alignmentMode === mode ? 'on' : '';
    button.addEventListener('click', () => {
      const current = state.edits.get(item.zIndex)?.alignmentMode;
      setEdit(item.zIndex, { alignmentMode: current === mode ? undefined : mode });
    });
    alignGroup.append(button);
  }

  const extraToggle = document.createElement('button');
  extraToggle.type = 'button';
  extraToggle.className = 'btn btn-ghost btn-sm extra-toggle';
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

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn btn-ghost btn-sm item-reset';
  reset.textContent = '撤销本条';
  reset.title = '清除本条的新文案、字体、对齐和调整说明';
  reset.disabled = Object.keys(edit).length === 0;
  reset.addEventListener('click', () => resetItem(item.zIndex));

  tools.append(fontSelect, alignGroup, extraToggle, reset);
  node.append(head, input, tools, extra);
  return node;
}

function syncItem(index) {
  const node = el.elementList.querySelector(`.item[data-index="${index}"]`);
  if (!node) return;
  const edit = state.edits.get(index) ?? {};
  node.classList.toggle('active', index === state.activeIndex);
  node.classList.toggle('edited', hasEdit(index));
  for (const button of node.querySelectorAll('.align-group button[data-mode]')) {
    button.classList.toggle('on', edit.alignmentMode === button.dataset.mode);
  }
  const extra = node.querySelector('input.extra');
  const extraToggle = node.querySelector('.extra-toggle');
  if (extraToggle) extraToggle.textContent = edit.extraInstruction ? '调整说明 ✓' : '＋调整说明';
  if (extra && !edit.extraInstruction && document.activeElement !== extra) extra.classList.add('hidden');
  const reset = node.querySelector('.item-reset');
  if (reset) reset.disabled = Object.keys(edit).length === 0;
  node.querySelector('.font-select')?.refresh?.();
}

function resetItem(index) {
  state.edits.delete(index);
  const node = el.elementList.querySelector(`.item[data-index="${index}"]`);
  if (node) {
    const input = node.querySelector('textarea');
    const extra = node.querySelector('input.extra');
    if (input) input.value = '';
    if (extra) {
      extra.value = '';
      extra.classList.add('hidden');
    }
  }
  syncItem(index);
  syncBoxClasses();
  updateGenerateState();
  scheduleDraftSave();
  toast('已撤销本条修改', 'ok');
}

function focusItem(index, scroll = true) {
  state.activeIndex = index;
  const item = state.elements.find((candidate) => candidate.zIndex === index);
  if (item && !itemMatchesView(item)) {
    state.elementFilter = 'all';
    state.elementSearch = '';
    el.elementSearch.value = '';
    applyListView();
  }
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
  return Boolean(modified) && (REMOVAL_KEYWORDS.has(modified) || modified !== original);
}

function setEdit(index, patch) {
  const current = state.edits.get(index) ?? {};
  const next = { ...current, ...patch };
  for (const key of Object.keys(next)) if (next[key] === undefined || next[key] === '') delete next[key];
  if (Object.keys(next).length === 0) state.edits.delete(index);
  else state.edits.set(index, next);
  syncItem(index);
  syncBoxClasses();
  updateGenerateState();
  scheduleDraftSave();
}

function applyFontToEdited() {
  const targets = state.elements.filter((item) => hasEdit(item.zIndex));
  if (!targets.length) return;
  const fontId = el.batchFont.value || undefined;
  for (const item of targets) {
    const next = { ...(state.edits.get(item.zIndex) ?? {}) };
    if (fontId) next.fontId = fontId;
    else delete next.fontId;
    state.edits.set(item.zIndex, next);
    syncItem(item.zIndex);
  }
  syncBoxClasses();
  updateGenerateState();
  scheduleDraftSave();
  const label = fontById(fontId)?.label ?? '自动保留原样';
  toast(`已将 ${label} 应用到 ${targets.length} 个已修改项`, 'ok');
}

let searchDebounceTimer = null;
function scheduleListSearch() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    state.elementSearch = compact(el.elementSearch.value);
    applyListView();
  }, 180);
}

let draftSaveTimer = null;
function setDraftStatus(message, kind = '') {
  if (!el.draftStatus) return;
  el.draftStatus.textContent = message;
  el.draftStatus.className = `small draft-status${kind ? ` ${kind}` : ''}`;
}

function serializedEdits() {
  return [...state.edits.entries()].map(([index, edit]) => ({ index, ...edit }));
}

function scheduleDraftSave() {
  if (!state.draftId) return;
  clearTimeout(draftSaveTimer);
  setDraftStatus('保存中…');
  draftSaveTimer = setTimeout(saveDraft, 700);
}

async function saveDraft() {
  if (!state.draftId) return;
  const draftId = state.draftId;
  try {
    await api(`/api/drafts/${encodeURIComponent(draftId)}`, {
      method: 'PUT',
      body: JSON.stringify({ edits: serializedEdits() }),
    });
    if (state.draftId === draftId) setDraftStatus('已自动保存', 'ok');
  } catch (error) {
    setDraftStatus('保存失败', 'error');
    toast(`草稿保存失败：${error.message}`);
  }
}

async function restoreLatestDraft() {
  try {
    const { draft } = await api('/api/drafts/latest');
    if (!draft) return;
    const dataUrl = await imageUrlAsDataUrl(draft.imageUrl);
    state.imageDataUrl = dataUrl;
    state.draftId = draft.id;
    state.canvas = draft.canvas;
    state.elements = draft.elements;
    state.edits = new Map((draft.edits ?? []).map(({ index, ...edit }) => [Number(index), edit]));
    state.activeIndex = null;
    el.preview.src = dataUrl;
    el.canvasInfo.textContent = `${draft.canvas.width} × ${draft.canvas.height} px`;
    el.listTitle.textContent = `识别到 ${state.elements.length} 处文字`;
    resetListView();
    renderBoxes();
    renderList();
    updateGenerateState();
    showStage('edit');
    setDraftStatus('已恢复并自动保存', 'ok');
  } catch (error) {
    console.warn('[draft] 恢复失败:', error.message);
  }
}

function collectChanges() {
  const changes = [];
  for (const item of state.elements) {
    if (!hasEdit(item.zIndex)) continue;
    const edit = state.edits.get(item.zIndex);
    const modified = edit.modified.trim();
    const remove = REMOVAL_KEYWORDS.has(modified);
    changes.push({
      original: item.text,
      modified,
      remove,
      alignmentMode: edit.alignmentMode,
      extraInstruction: edit.extraInstruction,
      isVertical: item.isVertical,
      fontSize: item.fontSize,
      fontId: edit.fontId,
      // 原图像素坐标，不是页面上量出来的
      box: { x: item.x, y: item.y, w: item.w, h: item.h },
    });
  }
  return changes;
}

function updateGenerateState() {
  const changes = collectChanges();
  const count = changes.length;
  el.btnGenerate.disabled = count === 0;
  el.editCount.textContent = count === 0 ? '未改动' : `已改 ${count} 处`;
  el.editCount.className = `chip ${count === 0 ? 'chip-quiet' : 'chip-ok'}`;
  el.generationSummary.textContent = count === 0 ? '尚未修改文案' : `准备生成 ${count} 处修改`;
  updateGenerationMeta();
  el.generateHint.textContent = count === 0
    ? '输入新文案；输入“消除”可清除对应识别框'
    : `将提交 ${count} 处改动（“消除”会清除对应范围）`;
  renderChangeLog(changes);
  applyListView();
}

function renderChangeLog(changes) {
  el.changeLog.classList.toggle('hidden', changes.length === 0);
  el.changeLogCount.textContent = String(changes.length);
  el.changeLogList.replaceChildren(...changes.map((change) => {
    const item = state.elements.find((element) =>
      element.text === change.original && element.x === change.box.x && element.y === change.box.y);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'change-log-row';
    row.title = '点击定位到对应识别框';
    const before = document.createElement('span');
    before.className = 'change-log-before';
    before.textContent = change.original;
    const arrow = document.createElement('span');
    arrow.className = 'change-log-arrow';
    arrow.textContent = '→';
    const after = document.createElement('strong');
    after.className = change.remove ? 'change-log-remove' : '';
    after.textContent = change.remove ? '清除该范围' : change.modified;
    row.append(before, arrow, after);
    if (change.fontId) {
      const selected = state.fonts.find((font) => font.id === change.fontId);
      if (selected) row.title = `点击定位到对应识别框 · 字体 ${selected.label}`;
    }
    if (item) row.addEventListener('click', () => focusItem(item.zIndex));
    return row;
  }));
}

// ---------- 生成 & 轮询 ----------

async function generate() {
  const changes = collectChanges();
  if (!changes.length) return;

  clearTimeout(draftSaveTimer);
  await saveDraft();
  el.btnGenerate.disabled = true;
  showStage('result');
  el.resultTitle.textContent = '正在生成…';
  el.btnDownload.classList.add('hidden');
  el.btnNext.classList.add('hidden');
  updateGenerationProgress({ message: '提交中…', elapsedMs: 0 });

  try {
    const { taskId } = await api('/api/ocr/generate', {
      method: 'POST',
      body: JSON.stringify({ imageBase64: state.imageDataUrl, changes, draftId: state.draftId }),
    });
    state.taskId = taskId;
    state.pollErrors = 0;
    updateGenerationProgress({
      message: state.imageProvider === 'codex' ? 'Codex 正在编辑海报…' : '已排队，等待处理…',
      elapsedMs: 0,
    });
    pollTask(taskId, Date.now() + POLL_TIMEOUT_MS);
  } catch (error) {
    showFailure(error.message);
  } finally {
    el.btnGenerate.disabled = false;
  }
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}分${rest}秒` : `${minutes}分钟`;
}

function formatDateTime(value) {
  if (!value) return '刚刚';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(value));
}

function remainingEstimate(elapsedMs) {
  const { minMs, maxMs } = state.imageEstimate;
  if (elapsedMs >= maxMs) return '已超过常见时长，仍在处理（最长等待 25 分钟）';
  const low = Math.max(0, minMs - elapsedMs);
  const high = Math.max(0, maxMs - elapsedMs);
  if (low < 30_000) return `预计还需不超过 ${formatDuration(high)}`;
  return `预计还需约 ${formatDuration(low)}–${formatDuration(high)}`;
}

function spinnerBlock() {
  const wrap = document.createElement('div');
  wrap.className = 'generation-progress';
  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  const note = document.createElement('p');
  note.className = 'generation-message';
  const timing = document.createElement('p');
  timing.className = 'generation-timing';
  const track = document.createElement('div');
  track.className = 'generation-track';
  const bar = document.createElement('div');
  bar.className = 'generation-bar';
  track.append(bar);
  const hint = document.createElement('p');
  hint.className = 'muted small generation-hint';
  wrap.append(spinner, note, timing, track, hint);
  return wrap;
}

function updateGenerationProgress({ message, elapsedMs }) {
  let block = el.resultBody.querySelector('.generation-progress');
  if (!block) {
    block = spinnerBlock();
    el.resultBody.replaceChildren(block);
  }
  block.querySelector('.generation-message').textContent = message;
  const timing = block.querySelector('.generation-timing');
  const bar = block.querySelector('.generation-bar');
  const hint = block.querySelector('.generation-hint');
  if (state.imageProvider === 'codex') {
    timing.textContent = `已等待 ${formatDuration(elapsedMs)} · ${remainingEstimate(elapsedMs)}`;
    const percent = Math.min(95, Math.max(3, Math.round((elapsedMs / state.imageEstimate.maxMs) * 100)));
    bar.style.width = `${percent}%`;
    hint.textContent = state.imageEstimate.samples >= 3
      ? `根据最近 ${state.imageEstimate.samples} 次成功任务估算，实际时间会随图片复杂度变化`
      : '当前历史样本较少，先按常见的 5–15 分钟估算';
  } else {
    timing.textContent = `已等待 ${formatDuration(elapsedMs)}`;
    bar.style.width = '20%';
    hint.textContent = '正在等待服务返回结果';
  }
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
        const elapsedMs = Number(body.elapsedMs) || (POLL_TIMEOUT_MS - (deadline - Date.now()));
        const prefix = state.imageProvider === 'codex' ? 'Codex 生图中' : '处理中';
        updateGenerationProgress({ message: `${prefix}…`, elapsedMs });
        pollTask(taskId, deadline);
      }
    } catch (error) {
      // 短暂断网或服务繁忙不应立刻把仍在运行的任务判成失败。
      state.pollErrors += 1;
      if (Date.now() > deadline) showFailure(`无法取得任务最终状态：${error.message}`);
      else {
        updateGenerationProgress({
          message: `连接暂时中断，正在重试…（第 ${state.pollErrors} 次）`,
          elapsedMs: POLL_TIMEOUT_MS - (deadline - Date.now()),
        });
        pollTask(taskId, deadline);
      }
    }
  }, POLL_INTERVAL_MS);
}

function showSuccess(body) {
  clearTimeout(state.pollTimer);
  const url = body.data?.[0];
  if (!url) {
    showFailure('任务完成但没有返回图片');
    return;
  }
  el.resultTitle.textContent = '生成完成';

  const completion = document.createElement('div');
  completion.className = 'result-completion';
  const duration = document.createElement('strong');
  duration.className = 'result-duration';
  duration.textContent = `图片生成耗时：${formatDuration(Number(body.elapsedMs) || 0)}`;
  const finished = document.createElement('span');
  finished.className = 'muted small';
  finished.textContent = `完成时间：${formatDateTime(body.completedAt)}`;
  completion.append(duration, finished);

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
    img.dataset.zoomable = 'true';
    img.title = '点击放大查看';
    figure.append(figcaption, img);
    compare.append(figure);
  }
  el.resultBody.replaceChildren(completion, compare);

  el.btnDownload.href = url;
  el.btnDownload.classList.remove('hidden');
  el.btnNext.classList.remove('hidden');
  setDraftStatus('已生成并保存到记录', 'ok');
  toast('生成完成', 'ok');
}

function showFailure(message) {
  clearTimeout(state.pollTimer);
  el.resultTitle.textContent = '生成失败';
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = message;
  el.resultBody.replaceChildren(note);
  el.btnNext.classList.remove('hidden');
  toast(message);
}

async function startNewPoster({ findLatest = false } = {}) {
  clearTimeout(state.pollTimer);
  clearTimeout(draftSaveTimer);
  clearTimeout(searchDebounceTimer);
  let draftId = state.draftId;
  if (!draftId && findLatest) {
    try {
      const { draft } = await api('/api/drafts/latest');
      draftId = draft?.id ?? null;
    } catch (error) {
      console.warn('[draft] 查询当前草稿失败:', error.message);
    }
  }

  Object.assign(state, { imageDataUrl: null, draftId: null, canvas: null, elements: [], activeIndex: null, taskId: null });
  state.edits.clear();
  state.elementFilter = 'all';
  state.elementSearch = '';
  el.elementSearch.value = '';
  el.fileInput.value = '';
  el.btnDownload.classList.add('hidden');
  el.btnNext.classList.add('hidden');
  showStage('upload');

  if (draftId) {
    try {
      await api(`/api/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' });
    } catch (error) {
      console.warn('[draft] 删除失败:', error.message);
    }
  }
}

// ---------- 事件绑定 ----------

el.fileInput.addEventListener('change', (event) => handleFile(event.target.files?.[0]));
document.addEventListener('paste', handlePaste);

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
el.btnZoom.addEventListener('click', () => el.preview.click());
el.elementSearch.addEventListener('input', scheduleListSearch);
el.elementSearch.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  clearTimeout(searchDebounceTimer);
  el.elementSearch.value = '';
  state.elementSearch = '';
  applyListView();
});
el.elementFilters.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (!button) return;
  state.elementFilter = button.dataset.filter;
  applyListView();
});
el.btnApplyFont.addEventListener('click', applyFontToEdited);

el.btnBack.addEventListener('click', () => {
  clearTimeout(state.pollTimer);
  state.taskId = null;
  showStage('edit');
});

el.btnNext.addEventListener('click', () => startNewPoster());
el.btnReset.addEventListener('click', () => startNewPoster());

Promise.all([refreshStatus(), refreshFonts()]).then(() => {
  if (state.elements.length) renderList();
});
if (new URLSearchParams(location.search).get('new') === '1') {
  startNewPoster({ findLatest: true }).finally(() => {
    window.history.replaceState(null, '', 'index.html');
  });
} else {
  restoreLatestDraft();
}
