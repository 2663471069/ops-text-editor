// 输入校验。原规格 README 要求「限制图片体积、MIME、解码尺寸和 prompt 长度」，
// 但参考实现只用正则查了 data URL 前缀，这里补齐。

export const LIMITS = {
  maxImageBytes: 12 * 1024 * 1024, // 解码后的原始字节
  maxBase64Chars: 20 * 1024 * 1024, // 先卡字符串长度，避免为超大输入分配 Buffer
  maxPixels: 40_000_000, // 宽 × 高，防解压炸弹
  maxPromptChars: 8000,
  maxChanges: 30,
  maxTextChars: 200,
  maxInstructionChars: 200,
};

// MIME → 魔术字节。声明的类型必须和实际内容一致，否则拒绝。
const MAGIC = new Map([
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
]);

const MIME_ALIAS = new Map([
  ['image/jpg', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
]);

const DATA_URL_HEAD = /^data:(image\/[\w.+-]+);base64,/i;
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * 严格解析 data URL：校验前缀、MIME 白名单、base64 合法性、体积、魔术字节。
 * @returns {{mime:string, buffer:Buffer} | {error:string}}
 */
export function parseImageDataUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return { error: '缺少原始图片' };
  const raw = value.trim();
  if (raw.length > LIMITS.maxBase64Chars) {
    return { error: `图片数据过大（上限 ${Math.floor(LIMITS.maxBase64Chars / 1024 / 1024)}MB base64）` };
  }

  const head = DATA_URL_HEAD.exec(raw);
  if (!head) return { error: '图片必须是 data:image/*;base64 格式' };

  const declared = head[1].toLowerCase();
  const mime = MIME_ALIAS.get(declared) ?? declared;
  if (!MAGIC.has(mime)) {
    return { error: `不支持的图片类型 ${declared}，仅支持 JPEG / PNG / WebP` };
  }

  // Buffer.from(..., 'base64') 会静默忽略非法字符，所以必须先自己校验字符集。
  const body = raw.slice(head[0].length).replace(/\s+/g, '');
  if (!body || !BASE64_BODY.test(body)) return { error: 'base64 数据非法' };

  let buffer;
  try {
    buffer = Buffer.from(body, 'base64');
  } catch {
    return { error: 'base64 解码失败' };
  }
  if (buffer.length === 0) return { error: '图片内容为空' };
  if (buffer.length > LIMITS.maxImageBytes) {
    return { error: `图片超过 ${Math.floor(LIMITS.maxImageBytes / 1024 / 1024)}MB 上限` };
  }
  if (!MAGIC.get(mime)(buffer)) {
    return { error: `图片内容与声明的类型 ${declared} 不符` };
  }
  return { mime, buffer };
}

/** 解码后的像素总数上限，防解压炸弹。由 codec 拿到真实宽高后调用。 */
export function assertPixelBudget(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('图片尺寸非法');
  }
  if (width * height > LIMITS.maxPixels) {
    throw new Error(`图片像素数超过上限（${width}×${height}）`);
  }
}

/** POST /ocr/detect 的请求体校验。 */
export function parseDetectRequest(body = {}) {
  const image = parseImageDataUrl(body.imageBase64);
  if (image.error) return { error: image.error };

  let minAreaPercent = 0.05; // 单位：百分比(%)。原规格 `minAreaPercent: 0.25` 未注明单位，这里明确为 %。
  if (body.minAreaPercent !== undefined && body.minAreaPercent !== null && body.minAreaPercent !== '') {
    const n = Number(body.minAreaPercent);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { error: 'minAreaPercent 必须是 0-100 之间的数字（单位 %）' };
    minAreaPercent = n;
  }

  const excludeRects = [];
  if (body.excludeRects !== undefined) {
    if (!Array.isArray(body.excludeRects)) return { error: 'excludeRects 必须是数组' };
    if (body.excludeRects.length > 50) return { error: 'excludeRects 过多' };
    for (const r of body.excludeRects) {
      const rect = ['x', 'y', 'w', 'h'].map((k) => Number(r?.[k]));
      if (rect.some((n) => !Number.isFinite(n))) return { error: 'excludeRects 元素必须是 {x,y,w,h} 数字' };
      const [x, y, w, h] = rect;
      if (w <= 0 || h <= 0) return { error: 'excludeRects 的 w/h 必须为正' };
      excludeRects.push({ x, y, w, h });
    }
  }

  return { image, minAreaPercent, excludeRects };
}

/**
 * POST /ocr/generate 的请求体校验。
 * 对应原规格 reference/ocr-generation-request.js，补上 prompt 长度与 base64 实际解码。
 */
export function parseGenerateRequest(body = {}) {
  const image = parseImageDataUrl(body.imageBase64);
  if (image.error) return { error: image.error };

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt.length > LIMITS.maxPromptChars) {
    return { error: `提示词超过 ${LIMITS.maxPromptChars} 字上限（当前 ${prompt.length}）` };
  }

  // 结构化变更。给了 changes 就由服务端拼提示词（模板留在服务端，也是本地合成的必需输入）；
  // 只给 prompt 则按原契约原样透传，仅 AI 出图可用。
  let changes = null;
  if (body.changes !== undefined && body.changes !== null) {
    if (!Array.isArray(body.changes)) return { error: 'changes 必须是数组' };
    if (body.changes.length === 0) return { error: 'changes 不能为空数组' };
    if (body.changes.length > LIMITS.maxChanges) {
      return { error: `一次最多修改 ${LIMITS.maxChanges} 处文字` };
    }
    changes = body.changes;
  }

  if (!changes && !prompt) return { error: '缺少提示词或文字变更' };

  return { image, prompt, changes, action: '文案修改' };
}
