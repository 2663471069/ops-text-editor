// 图片解码 / 缩放 / 量尺寸。对应原规格「压缩输入图」那一步：
// 短边超过 2048px 按比例缩小，转 JPEG quality 85。

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { assertPixelBudget } from '../validate.js';

export const MAX_SHORT_EDGE = 2048;
export const JPEG_QUALITY = 85;

/** @returns {Promise<import('@napi-rs/canvas').Image>} */
export async function decode(buffer) {
  let image;
  try {
    image = await loadImage(buffer);
  } catch (error) {
    throw new Error(`图片解码失败：${error.message}`);
  }
  assertPixelBudget(image.width, image.height);
  return image;
}

export async function measure(buffer) {
  const image = await decode(buffer);
  return { width: image.width, height: image.height };
}

/**
 * 需要时等比缩小并重编码为 JPEG。
 * @returns {Promise<{buffer:Buffer, mime:string, width:number, height:number, scaled:boolean}>}
 */
export async function compress(buffer, { maxShortEdge = MAX_SHORT_EDGE, quality = JPEG_QUALITY } = {}) {
  const image = await decode(buffer);
  const shortEdge = Math.min(image.width, image.height);
  const ratio = shortEdge > maxShortEdge ? maxShortEdge / shortEdge : 1;

  const width = Math.max(1, Math.round(image.width * ratio));
  const height = Math.max(1, Math.round(image.height * ratio));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height);

  return {
    buffer: await canvas.encode('jpeg', quality),
    mime: 'image/jpeg',
    width,
    height,
    scaled: ratio !== 1,
  };
}

export function toDataUrl(buffer, mime = 'image/jpeg') {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}
