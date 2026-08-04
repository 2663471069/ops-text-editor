// 生成一张「测试用海报」：白底 + 已知的几行黑字。
// 配置页的「测试连接」拿它跑一次真实 OCR，就能验证密钥是否可用、识别效果如何——
// 比只检查「密钥非空」有意义得多。

import { createCanvas } from '@napi-rs/canvas';
import { ensureFont } from './local.js';

export const PROBE_TEXTS = ['文案修改测试', '春季新品上市', '全场五折'];

export async function makeProbeImage() {
  const family = ensureFont();
  const width = 800;
  const height = 600;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#111111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const sizes = [64, 44, 52];
  let y = 150;
  for (const [i, text] of PROBE_TEXTS.entries()) {
    ctx.font = `${sizes[i]}px "${family}"`;
    ctx.fillText(text, width / 2, y);
    y += 160;
  }

  return {
    buffer: await canvas.encode('jpeg', 92),
    mime: 'image/jpeg',
    width,
    height,
    expected: PROBE_TEXTS,
  };
}
