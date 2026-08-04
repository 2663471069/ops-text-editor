// 腾讯云 OCR（GeneralAccurateOCR）。TC3-HMAC-SHA256 手工签名，不引入官方 SDK。
// 原规格的数据格式（Polygon / ItemPolygon）就是这家的。

import { createHash, createHmac } from 'node:crypto';

const HOST = 'ocr.tencentcloudapi.com';
const SERVICE = 'ocr';
const VERSION = '2018-11-19';
const ACTION = 'GeneralAccurateOCR';
const ALGORITHM = 'TC3-HMAC-SHA256';

const sha256hex = (data) => createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key, msg) => createHmac('sha256', key).update(msg, 'utf8').digest();

function sign({ secretId, secretKey, payload, timestamp }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // 必须是 UTC 日期

  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalHeaders =
    'content-type:application/json; charset=utf-8\n' + `host:${HOST}\n` + `x-tc-action:${ACTION.toLowerCase()}\n`;
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256hex(payload)].join('\n');

  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [ALGORITHM, timestamp, credentialScope, sha256hex(canonicalRequest)].join('\n');

  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');

  return `${ALGORITHM} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** ItemPolygon 优先（已经是矩形），否则用 Polygon 四顶点求包围盒。 */
function toBox(detection) {
  const item = detection.ItemPolygon;
  if (item && Number(item.Width) > 0 && Number(item.Height) > 0) {
    return { x: Number(item.X), y: Number(item.Y), w: Number(item.Width), h: Number(item.Height) };
  }
  const polygon = detection.Polygon;
  if (Array.isArray(polygon) && polygon.length >= 3) {
    const xs = polygon.map((p) => Number(p.X));
    const ys = polygon.map((p) => Number(p.Y));
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  return null;
}

export async function detect({ credentials, imageBase64Body }) {
  const { secretId, secretKey, region } = credentials ?? {};
  if (!secretId || !secretKey) {
    const err = new Error('未配置腾讯云 OCR 密钥（SecretId / SecretKey）');
    err.statusCode = 400;
    throw err;
  }

  const payload = JSON.stringify({ ImageBase64: imageBase64Body });
  const timestamp = Math.floor(Date.now() / 1000);

  const response = await fetch(`https://${HOST}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Host: HOST,
      'X-TC-Action': ACTION,
      'X-TC-Version': VERSION,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Region': region || 'ap-guangzhou',
      Authorization: sign({ secretId, secretKey, payload, timestamp }),
    },
    body: payload,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`腾讯云 OCR HTTP ${response.status}`);
  }
  const body = await response.json();
  const result = body?.Response;
  if (result?.Error) {
    // 只回传厂商错误码和描述，不带请求头或密钥
    throw new Error(`腾讯云 OCR ${result.Error.Code}: ${result.Error.Message}`);
  }

  const detections = Array.isArray(result?.TextDetections) ? result.TextDetections : [];
  return detections
    .map((d) => ({ text: d.DetectedText, confidence: Number(d.Confidence), box: toBox(d) }))
    .filter((item) => item.box);
}
