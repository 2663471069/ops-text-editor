// 配置与密钥。密钥只落盘到 data/（已 gitignore），对外一律脱敏。
// 原规格支持多密钥轮换（POST /config/keys + activeKeyId）；单机单人用不上，
// 这里简化为每个服务商一套凭据，其余契约字段保留。

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const OCR_PROVIDERS = ['codex', 'mock', 'tencent', 'baidu', 'aliyun'];
export const IMAGE_PROVIDERS = ['local', 'codex', 'openai'];
export const ENDPOINT_MODES = ['edits', 'generations'];

function defaults() {
  return {
    ocr: {
      provider: 'codex',
      region: 'ap-guangzhou', // 腾讯云用
      secretId: '', // 腾讯云 SecretId / 百度 API Key
      secretKey: '', // 腾讯云 SecretKey / 百度 Secret Key
      minAreaPercent: 0.05,
    },
    image: {
      provider: 'codex',
      baseUrl: '',
      model: '',
      endpointMode: 'edits',
      apiKey: '',
      quality: 'high',
    },
    prompts: {
      textEditorPrompt: '', // 空 = 用 prompt.js 里的 DEFAULT_TEMPLATE
    },
    limits: {
      perUser: 2,
      globalMax: 6,
    },
  };
}

/** 深合并，只认已知字段，忽略外来键。 */
function merge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in base)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof base[key] === 'object') {
      out[key] = merge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

let cache = null;

export function load() {
  if (cache) return cache;
  let stored = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      stored = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      console.warn('[config] data/config.json 解析失败，回退到默认配置');
      stored = {};
    }
  }
  cache = merge(defaults(), stored);
  return cache;
}

export function save(next) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, CONFIG_FILE); // 原子替换，避免写一半被读到
  cache = next;
  return cache;
}

/** 只留后 4 位，其余打点。空值返回 ''。 */
function mask(secret) {
  const s = String(secret ?? '');
  if (!s) return '';
  if (s.length <= 4) return '•'.repeat(s.length);
  return '•'.repeat(Math.min(12, s.length - 4)) + s.slice(-4);
}

/** 给前端的视图：绝不包含明文密钥。 */
export function getPublic() {
  const c = load();
  return {
    ocr: {
      provider: c.ocr.provider,
      region: c.ocr.region,
      secretIdMasked: mask(c.ocr.secretId),
      secretKeyMasked: mask(c.ocr.secretKey),
      hasCredentials: Boolean(c.ocr.secretId && c.ocr.secretKey),
      minAreaPercent: c.ocr.minAreaPercent,
    },
    image: {
      provider: c.image.provider,
      baseUrl: c.image.baseUrl,
      model: c.image.model,
      endpointMode: c.image.endpointMode,
      apiKeyMasked: mask(c.image.apiKey),
      hasApiKey: Boolean(c.image.apiKey),
      quality: c.image.quality,
    },
    prompts: {
      textEditorPrompt: c.prompts.textEditorPrompt,
    },
    limits: { ...c.limits },
    providers: { ocr: OCR_PROVIDERS, image: IMAGE_PROVIDERS, endpointModes: ENDPOINT_MODES },
  };
}

/**
 * 更新配置。密钥字段传空字符串 = 保持原值不变（前端显示的是掩码，不该把掩码写回来）。
 * 传 null 才是显式清空。
 */
export function update(patch = {}) {
  const current = load();
  const next = merge(current, patch);

  if (!OCR_PROVIDERS.includes(next.ocr.provider)) {
    return { error: `不支持的 OCR 服务商 ${next.ocr.provider}` };
  }
  if (!IMAGE_PROVIDERS.includes(next.image.provider)) {
    return { error: `不支持的出图方式 ${next.image.provider}` };
  }
  if (!ENDPOINT_MODES.includes(next.image.endpointMode)) {
    return { error: `endpointMode 只能是 ${ENDPOINT_MODES.join(' / ')}` };
  }
  if (next.image.baseUrl && !/^https?:\/\//i.test(next.image.baseUrl)) {
    return { error: 'API 地址必须以 http:// 或 https:// 开头' };
  }
  for (const [scope, field] of [
    ['ocr', 'secretId'],
    ['ocr', 'secretKey'],
    ['image', 'apiKey'],
  ]) {
    const incoming = patch?.[scope]?.[field];
    if (incoming === null) next[scope][field] = '';
    else if (incoming === '' || incoming === undefined) next[scope][field] = current[scope][field];
    else if (String(incoming).includes('•')) next[scope][field] = current[scope][field]; // 掩码被原样提交，忽略
  }

  const perUser = Number(next.limits.perUser);
  const globalMax = Number(next.limits.globalMax);
  if (!Number.isInteger(perUser) || perUser < 1 || perUser > 20) return { error: '单用户并发需为 1-20 的整数' };
  if (!Number.isInteger(globalMax) || globalMax < 1 || globalMax > 100) return { error: '全局并发需为 1-100 的整数' };

  save(next);
  return { config: getPublic() };
}

/** 服务端内部用，含明文密钥。禁止直接序列化给前端。 */
export function getSecrets() {
  const c = load();
  return { ocr: { ...c.ocr }, image: { ...c.image } };
}

export function reset() {
  cache = null;
}

export const paths = { ROOT, DATA_DIR, CONFIG_FILE };
