// 百度智能云 OCR（通用文字识别·高精度含位置）。先用 API Key / Secret Key 换 access_token，
// 再调 accurate 接口。token 有效期约 30 天，这里内存缓存并提前 5 分钟过期。

const TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token';
const OCR_URL = 'https://aip.baidubce.com/rest/2.0/ocr/v1/accurate';

let cached = null; // { token, expiresAt, key }

async function getToken({ secretId, secretKey }) {
  const cacheKey = `${secretId}:${secretKey.slice(-6)}`;
  if (cached && cached.key === cacheKey && cached.expiresAt > Date.now()) return cached.token;

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: secretId,
    client_secret: secretKey,
  });
  const response = await fetch(`${TOKEN_URL}?${params}`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`百度 OCR 取 token 失败 HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`百度 OCR 鉴权失败: ${body.error_description ?? body.error}`);
  if (!body.access_token) throw new Error('百度 OCR 未返回 access_token');

  cached = {
    token: body.access_token,
    expiresAt: Date.now() + Math.max(60, Number(body.expires_in ?? 2592000) - 300) * 1000,
    key: cacheKey,
  };
  return cached.token;
}

export async function detect({ credentials, imageBase64Body }) {
  const { secretId, secretKey } = credentials ?? {};
  if (!secretId || !secretKey) {
    const err = new Error('未配置百度 OCR 密钥（API Key / Secret Key）');
    err.statusCode = 400;
    throw err;
  }

  const token = await getToken({ secretId, secretKey });
  const response = await fetch(`${OCR_URL}?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ image: imageBase64Body, detect_direction: 'true' }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`百度 OCR HTTP ${response.status}`);

  const body = await response.json();
  if (body.error_code) {
    cached = null; // token 可能失效，下次重新取
    throw new Error(`百度 OCR ${body.error_code}: ${body.error_msg}`);
  }

  const words = Array.isArray(body.words_result) ? body.words_result : [];
  return words
    .map((item) => {
      const loc = item.location ?? {};
      const w = Number(loc.width);
      const h = Number(loc.height);
      if (!(w > 0) || !(h > 0)) return null;
      return {
        text: item.words,
        confidence: null, // accurate 基础版不返回逐条置信度
        box: { x: Number(loc.left), y: Number(loc.top), w, h },
      };
    })
    .filter(Boolean);
}
