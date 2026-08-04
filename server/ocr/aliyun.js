// 阿里云 OCR（文字识别统一版 ocr-api，2021-07-07）。
// 签名用 ACS3-HMAC-SHA256，与腾讯云的 TC3 是两套东西。
// 图片作为请求体原始字节发送，参数走 query string。

import { createHash, createHmac, randomUUID } from 'node:crypto';

const ENDPOINT = 'ocr-api.cn-hangzhou.aliyuncs.com';
const VERSION = '2021-07-07';
const ACTION = 'RecognizeAdvanced'; // 全文识别高精版，返回逐行坐标
const ALGORITHM = 'ACS3-HMAC-SHA256';

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');

/** 阿里云要求的百分号编码：空格 %20、* 转 %2A、~ 不编码。 */
function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function canonicalQueryString(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');
}

function sign({ accessKeyId, accessKeySecret, headers, query, hashedPayload }) {
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${String(headers[name]).trim()}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    'POST',
    '/',
    canonicalQueryString(query),
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n');

  const stringToSign = `${ALGORITHM}\n${sha256hex(canonicalRequest)}`;
  const signature = createHmac('sha256', accessKeySecret).update(stringToSign, 'utf8').digest('hex');

  return {
    signedHeaders,
    authorization: `${ALGORITHM} Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}

/** prism_wordsInfo 的 pos 是四个顶点；老字段是 x/y/width/height，两种都兼容。 */
function toBox(word) {
  if (Array.isArray(word.pos) && word.pos.length >= 3) {
    const xs = word.pos.map((p) => Number(p.x));
    const ys = word.pos.map((p) => Number(p.y));
    if (xs.every(Number.isFinite) && ys.every(Number.isFinite)) {
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
  }
  const w = Number(word.width);
  const h = Number(word.height);
  if (w > 0 && h > 0) return { x: Number(word.x), y: Number(word.y), w, h };
  return null;
}

export async function detect({ credentials, imageBase64Body }) {
  const { secretId: accessKeyId, secretKey: accessKeySecret } = credentials ?? {};
  if (!accessKeyId || !accessKeySecret) {
    const error = new Error('未配置阿里云 OCR 密钥（AccessKey ID / AccessKey Secret）');
    error.statusCode = 400;
    throw error;
  }

  const body = Buffer.from(imageBase64Body, 'base64');
  const hashedPayload = sha256hex(body);

  // 需要逐行坐标，必须显式要求返回 word 信息
  const query = { NeedRotate: 'false', OutputFigure: 'false' };

  const headers = {
    host: ENDPOINT,
    'x-acs-action': ACTION,
    'x-acs-version': VERSION,
    'x-acs-date': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    'x-acs-signature-nonce': randomUUID().replace(/-/g, ''),
    'x-acs-content-sha256': hashedPayload,
  };

  const { authorization } = sign({ accessKeyId, accessKeySecret, headers, query, hashedPayload });

  const url = `https://${ENDPOINT}/?${canonicalQueryString(query)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, Authorization: authorization, 'Content-Type': 'application/octet-stream' },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`阿里云 OCR 返回了非 JSON 响应 (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  if (!response.ok || payload.Code) {
    // 只回传厂商错误码与描述，不带请求头或密钥
    throw new Error(`阿里云 OCR ${payload.Code ?? `HTTP ${response.status}`}: ${payload.Message ?? '未知错误'}`);
  }

  // Data 是一个 JSON 字符串，不是对象
  let data = payload.Data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error('阿里云 OCR 的 Data 字段无法解析');
    }
  }

  const words = Array.isArray(data?.prism_wordsInfo) ? data.prism_wordsInfo : [];
  return words
    .map((word) => ({
      text: word.word ?? word.text,
      confidence: Number.isFinite(Number(word.prob)) ? Number(word.prob) : null,
      box: toBox(word),
    }))
    .filter((item) => item.text && item.box);
}
