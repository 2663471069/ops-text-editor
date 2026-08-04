// 出图渠道选择。两条路的产物统一成 {data:[...], resultMode, notes}。
//
// local  —— 本地合成，不需要密钥，立刻可用；纯色背景效果好，复杂背景会留痕。
// codex  —— 复用当前 Codex 登录态和内置 imagegen，不需要单独 API Key。
// openai —— OpenAI 兼容的 /images/edits，需要密钥；任意背景都能重绘。
//
// 切换只改配置，业务层与路由层不用动。

import { compress, toDataUrl } from './codec.js';
import { render as renderLocal } from './local.js';
import { render as renderRemote } from './openai.js';
import { render as renderCodex } from './codex.js';

export async function generate({ provider, imageBuffer, prompt, changes, credentials }) {
  if (provider === 'local') {
    if (!Array.isArray(changes) || changes.length === 0) {
      const err = new Error('本地合成需要结构化的 changes（含坐标），请从识别结果提交');
      err.statusCode = 400;
      throw err;
    }
    const out = await renderLocal({ imageBuffer, changes });
    return {
      data: [toDataUrl(out.buffer, out.mime)],
      resultMode: 'dataUrl',
      notes: out.notes,
    };
  }

  if (provider === 'openai') {
    // 供应商侧有体积上限，先按规格压缩；size 由原图元数据推导
    const compressed = await compress(imageBuffer);
    const { results } = await renderRemote({
      imageBuffer: compressed.buffer,
      mime: compressed.mime,
      prompt,
      credentials,
      size: `${compressed.width}x${compressed.height}`,
    });
    return {
      data: results.map((r) => r.value),
      resultMode: results.every((r) => r.kind === 'url') ? 'url' : 'dataUrl',
      notes: compressed.scaled ? ['输入图短边超过 2048px，已等比缩小后提交'] : [],
    };
  }

  if (provider === 'codex') {
    const out = await renderCodex({ imageBuffer, changes, prompt });
    return {
      data: [toDataUrl(out.buffer, out.mime)],
      resultMode: 'dataUrl',
      notes: out.notes,
    };
  }

  throw new Error(`未知的出图方式 ${provider}`);
}
