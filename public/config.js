'use strict';

// 密钥输入框永远留空显示；提交空值 = 保持服务端原值不变。
// 页面从不接收明文密钥，只拿到掩码用于占位提示。

const $ = (id) => document.getElementById(id);

// 各家 OCR 的凭据字段叫法不同，标签跟着服务商变
const CREDENTIAL_LABELS = {
  tencent: { id: 'SecretId', key: 'SecretKey', region: true },
  baidu: { id: 'API Key', key: 'Secret Key', region: false },
  aliyun: { id: 'AccessKey ID', key: 'AccessKey Secret', region: false },
  mock: { id: 'SecretId', key: 'SecretKey', region: false },
  codex: { id: 'SecretId', key: 'SecretKey', region: false },
};

let toastTimer = null;
function toast(message, kind = 'error') {
  const node = $('toast');
  node.textContent = message;
  node.className = `toast${kind === 'ok' ? ' ok' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), 4500);
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

function syncOcrLabels() {
  const provider = $('ocr-provider').value;
  const labels = CREDENTIAL_LABELS[provider] ?? CREDENTIAL_LABELS.tencent;
  document.querySelector('.js-id-label').textContent = labels.id;
  document.querySelector('.js-key-label').textContent = labels.key;
  $('ocr-region-field').classList.toggle('hidden', !labels.region);
  $('ocr-credentials').classList.toggle('hidden', provider === 'mock' || provider === 'codex');
}

function syncImageRows() {
  const provider = document.querySelector('input[name="image-provider"]:checked')?.value ?? 'local';
  $('openai-fields').classList.toggle('hidden', provider !== 'openai');
  $('row-local').classList.toggle('on', provider === 'local');
  $('row-codex').classList.toggle('on', provider === 'codex');
  $('row-openai').classList.toggle('on', provider === 'openai');
}

async function loadConfig() {
  const { config } = await api('/api/ocr-text-edit/config');

  $('ocr-provider').value = config.ocr.provider;
  $('ocr-region').value = config.ocr.region ?? '';
  $('ocr-min-area').value = config.ocr.minAreaPercent ?? 0.05;
  $('ocr-secret-id').placeholder = config.ocr.secretIdMasked || '未设置';
  $('ocr-secret-key').placeholder = config.ocr.secretKeyMasked || '未设置';
  syncOcrLabels();

  const radio = document.querySelector(`input[name="image-provider"][value="${config.image.provider}"]`);
  if (radio) radio.checked = true;
  $('image-base-url').value = config.image.baseUrl ?? '';
  $('image-model').value = config.image.model ?? '';
  $('image-endpoint-mode').value = config.image.endpointMode ?? 'edits';
  $('image-api-key').placeholder = config.image.apiKeyMasked || '未设置';
  syncImageRows();

  $('limit-per-user').value = config.limits.perUser;
  $('limit-global').value = config.limits.globalMax;

  const prompts = await api('/api/product-showcase/prompts');
  $('prompt-template').value = prompts.textEditorPrompt || prompts.defaultTemplate;
  $('prompt-template').dataset.default = prompts.defaultTemplate;
}

async function saveOcr() {
  const patch = {
    ocr: {
      provider: $('ocr-provider').value,
      region: $('ocr-region').value.trim(),
      minAreaPercent: Number($('ocr-min-area').value),
      // 空字符串表示不改动，config.js 会保留原值
      secretId: $('ocr-secret-id').value.trim(),
      secretKey: $('ocr-secret-key').value.trim(),
    },
  };
  try {
    await api('/api/ocr-text-edit/config', { method: 'PUT', body: JSON.stringify(patch) });
    $('ocr-secret-id').value = '';
    $('ocr-secret-key').value = '';
    await loadConfig();
    toast('已保存', 'ok');
  } catch (error) {
    toast(error.message);
  }
}

async function saveImage() {
  const patch = {
    image: {
      provider: document.querySelector('input[name="image-provider"]:checked')?.value ?? 'local',
      baseUrl: $('image-base-url').value.trim(),
      model: $('image-model').value.trim(),
      endpointMode: $('image-endpoint-mode').value,
      apiKey: $('image-api-key').value.trim(),
    },
  };
  try {
    await api('/api/ocr-text-edit/config', { method: 'PUT', body: JSON.stringify(patch) });
    $('image-api-key').value = '';
    await loadConfig();
    toast('已保存', 'ok');
  } catch (error) {
    toast(error.message);
  }
}

async function saveLimits() {
  const patch = {
    limits: {
      perUser: Number($('limit-per-user').value),
      globalMax: Number($('limit-global').value),
    },
  };
  try {
    await api('/api/ocr-text-edit/config', { method: 'PUT', body: JSON.stringify(patch) });
    toast('已保存，重启服务后生效', 'ok');
  } catch (error) {
    toast(error.message);
  }
}

async function savePrompt() {
  try {
    await api('/api/product-showcase/prompts', {
      method: 'PUT',
      body: JSON.stringify({ textEditorPrompt: $('prompt-template').value }),
    });
    toast('已保存', 'ok');
  } catch (error) {
    toast(error.message);
  }
}

async function resetPrompt() {
  $('prompt-template').value = $('prompt-template').dataset.default ?? '';
  try {
    await api('/api/product-showcase/prompts', {
      method: 'PUT',
      body: JSON.stringify({ textEditorPrompt: '' }),
    });
    await loadConfig();
    toast('已恢复默认模板', 'ok');
  } catch (error) {
    toast(error.message);
  }
}

async function testOcr() {
  const output = $('test-output');
  const button = $('btn-test-ocr');
  output.classList.remove('hidden');
  output.textContent = '正在用一张测试海报跑一次真实识别…';
  button.disabled = true;
  try {
    const result = await api('/api/ocr-text-edit/config/test', { method: 'POST' });
    const lines = [
      `服务商：${result.provider}`,
      `耗时：${result.elapsedMs}ms`,
      `测试图上的文字：${result.expected.join(' / ')}`,
      `识别结果：${result.found.length ? result.found.join(' / ') : '（空）'}`,
      `命中：${result.matched}/${result.expected.length}`,
    ];
    if (result.provider === 'mock') {
      lines.push('', '注意：当前是假数据模式，上面的识别结果与图片内容无关。');
    } else if (result.matched === 0) {
      lines.push('', '密钥能调通，但一个字也没识别出来——检查是否开通了对应的 OCR 接口。');
    }
    output.textContent = lines.join('\n');
    toast('测试完成', 'ok');
  } catch (error) {
    output.textContent = `失败：${error.message}`;
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

$('ocr-provider').addEventListener('change', syncOcrLabels);
for (const radio of document.querySelectorAll('input[name="image-provider"]')) {
  radio.addEventListener('change', syncImageRows);
}
$('btn-save-ocr').addEventListener('click', saveOcr);
$('btn-test-ocr').addEventListener('click', testOcr);
$('btn-save-image').addEventListener('click', saveImage);
$('btn-save-limits').addEventListener('click', saveLimits);
$('btn-save-prompt').addEventListener('click', savePrompt);
$('btn-reset-prompt').addEventListener('click', resetPrompt);

loadConfig().catch((error) => toast(error.message));
