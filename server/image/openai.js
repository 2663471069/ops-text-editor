// OpenAI 兼容的图像编辑适配器（/images/edits）。需要 API Key。
// 按原规格：有输入图时走 multipart /images/edits，字段 image[]；
// 只在供应商明确要求时才用 generations JSON；同步 data[] 与异步 task_id 都要处理。

const SYNC_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

function joinUrl(baseUrl, pathname) {
  return `${String(baseUrl).replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`;
}

/** 只保留可安全展示的信息，绝不回传请求头或密钥。 */
async function readError(response, label) {
  let detail = '';
  try {
    const text = await response.text();
    const parsed = JSON.parse(text);
    detail = parsed?.error?.message ?? parsed?.message ?? text.slice(0, 200);
  } catch {
    detail = '';
  }
  return new Error(`${label} HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
}

function extractResults(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const results = [];
  for (const item of data) {
    if (item?.url) results.push({ kind: 'url', value: item.url });
    else if (item?.b64_json) results.push({ kind: 'dataUrl', value: `data:image/png;base64,${item.b64_json}` });
  }
  return results;
}

async function pollTask({ baseUrl, apiKey, taskId, signal }) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('任务已取消');
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const response = await fetch(joinUrl(baseUrl, `images/tasks/${encodeURIComponent(taskId)}`), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw await readError(response, '查询供应商任务');

    const body = await response.json();
    const status = String(body.status ?? body.state ?? '').toLowerCase();
    if (status === 'succeeded' || status === 'completed' || status === 'success') {
      const results = extractResults(body.result ?? body);
      if (!results.length) throw new Error('供应商任务完成但未返回图片');
      return results;
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(`供应商任务失败: ${body.error?.message ?? body.message ?? '未知原因'}`);
    }
  }
  throw new Error('供应商任务轮询超时');
}

/**
 * @param {{imageBuffer:Buffer, mime:string, prompt:string, credentials:object, size?:string}} input
 * @returns {Promise<{results:Array<{kind:string,value:string}>}>}
 */
export async function render({ imageBuffer, mime, prompt, credentials, size }) {
  const { baseUrl, apiKey, model, endpointMode = 'edits', quality = 'high' } = credentials ?? {};
  if (!baseUrl) {
    const err = new Error('未配置图像 API 地址');
    err.statusCode = 400;
    throw err;
  }
  if (!apiKey) {
    const err = new Error('未配置图像 API Key');
    err.statusCode = 400;
    throw err;
  }

  const headers = { Authorization: `Bearer ${apiKey}` };
  let response;

  if (endpointMode === 'generations') {
    // 供应商明确要求 JSON 模式时才走这条；此时无法传输入图，只能靠提示词描述。
    response = await fetch(joinUrl(baseUrl, 'images/generations'), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, size, quality, n: 1 }),
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
  } else {
    const form = new FormData();
    form.append('prompt', prompt);
    if (model) form.append('model', model);
    if (size) form.append('size', size);
    if (quality) form.append('quality', quality);
    form.append('n', '1');
    // 字段名 image[]：单图也用数组形式，与原规格一致
    form.append('image[]', new Blob([imageBuffer], { type: mime }), 'input.jpg');

    response = await fetch(joinUrl(baseUrl, 'images/edits'), {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
  }

  if (!response.ok) throw await readError(response, '图像供应商');

  const body = await response.json();

  const sync = extractResults(body);
  if (sync.length) return { results: sync };

  const taskId = body.task_id ?? body.taskId ?? body.id;
  if (taskId) {
    return { results: await pollTask({ baseUrl, apiKey, taskId }) };
  }

  throw new Error('供应商既未返回图片也未返回任务号');
}
