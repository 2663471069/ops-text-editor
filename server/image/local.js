// 本地合成渲染：不需要任何 AI 密钥就能出图。
//
// 原规格假设「出图」这一步一定走图像编辑模型，没有密钥就走不通。这条路作为补充：
// 把旧文字区域按背景色盖掉，再用探测到的文字颜色/字号/对齐重画新文字。
//
// 适用：纯色或近纯色背景上的文字（大多数促销海报的标题、价格、日期）。
// 不适用：文字压在照片、渐变、纹理上——盖掉的矩形会留痕。这种情况要用 AI 出图。

import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
import { decode, JPEG_QUALITY } from './codec.js';

// Windows 常见中文字体，按优先级注册第一个存在的
const FONT_CANDIDATES = [
  ['C:/Windows/Fonts/msyh.ttc', 'PosterSans'], // 微软雅黑
  ['C:/Windows/Fonts/msyhbd.ttc', 'PosterSansBold'],
  ['C:/Windows/Fonts/simhei.ttf', 'PosterSans'], // 黑体
  ['C:/Windows/Fonts/Deng.ttf', 'PosterSans'], // 等线
  ['/System/Library/Fonts/PingFang.ttc', 'PosterSans'],
  ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 'PosterSans'],
];

let fontFamily = null;

/** 注册并返回可用的中文字体族名。probe.js 也用它，避免测试图渲染成方块。 */
export function ensureFont() {
  if (fontFamily !== null) return fontFamily;
  for (const [file, alias] of FONT_CANDIDATES) {
    if (!existsSync(file)) continue;
    try {
      GlobalFonts.registerFromPath(file, alias);
      fontFamily = alias;
      return fontFamily;
    } catch {
      // 换下一个候选
    }
  }
  fontFamily = 'sans-serif'; // 兜底：中文可能变方块，但不至于崩
  console.warn('[local] 未找到可用中文字体，回退 sans-serif');
  return fontFamily;
}

/** 量化到 5 位精度分桶，纯色背景下众数比中位数更稳。 */
function quantize(r, g, b) {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

/**
 * 取众数桶，但返回桶内真实像素的均值而非桶的下界。
 * 直接用下界会丢掉 RGB 低 3 位——#f4ede2 会填成 rgb(240,232,224)，
 * 在纯色背景上就是一个肉眼可见的灰色方块。
 */
function modeColor(samples) {
  if (!samples.length) return { r: 255, g: 255, b: 255 };
  const buckets = new Map();
  for (const sample of samples) {
    let bucket = buckets.get(sample.key);
    if (!bucket) {
      bucket = { count: 0, r: 0, g: 0, b: 0 };
      buckets.set(sample.key, bucket);
    }
    bucket.count += 1;
    bucket.r += sample.r;
    bucket.g += sample.g;
    bucket.b += sample.b;
  }
  let best = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }
  return {
    r: Math.round(best.r / best.count),
    g: Math.round(best.g / best.count),
    b: Math.round(best.b / best.count),
  };
}

function colorDistance(a, b) {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

function rgb({ r, g, b }) {
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * 探测背景色：取包围盒外围一圈（不含盒内），众数。
 * 盒子贴边时只采样存在的那几侧。
 */
function detectBackground(ctx, box, canvasSize) {
  const pad = Math.max(3, Math.round(Math.min(box.w, box.h) * 0.25));
  const x0 = Math.max(0, box.x - pad);
  const y0 = Math.max(0, box.y - pad);
  const x1 = Math.min(canvasSize.width, box.x + box.w + pad);
  const y1 = Math.min(canvasSize.height, box.y + box.h + pad);
  if (x1 <= x0 || y1 <= y0) return { r: 255, g: 255, b: 255 };

  const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  const width = x1 - x0;
  const samples = [];
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const insideBox = px >= box.x && px < box.x + box.w && py >= box.y && py < box.y + box.h;
      if (insideBox) continue; // 只要盒外的一圈
      const i = ((py - y0) * width + (px - x0)) * 4;
      if (data[i + 3] < 200) continue; // 跳过透明像素
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      samples.push({ key: quantize(r, g, b), r, g, b });
    }
  }
  return modeColor(samples);
}

/** 探测文字色：盒内离背景色最远的那批像素的众数。 */
function detectTextColor(ctx, box, background) {
  const data = ctx.getImageData(box.x, box.y, box.w, box.h).data;
  const far = [];
  let maxDistance = 0;
  const distances = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const color = { r: data[i], g: data[i + 1], b: data[i + 2] };
    const d = colorDistance(color, background);
    distances.push({ d, key: quantize(color.r, color.g, color.b), ...color });
    if (d > maxDistance) maxDistance = d;
  }
  if (maxDistance < 40) {
    // 盒内几乎和背景同色（可能 OCR 框偏了）：用背景的反差色兜底
    const luma = 0.299 * background.r + 0.587 * background.g + 0.114 * background.b;
    return luma > 140 ? { r: 32, g: 32, b: 32 } : { r: 240, g: 240, b: 240 };
  }
  const threshold = maxDistance * 0.6;
  for (const item of distances) if (item.d >= threshold) far.push(item);
  return modeColor(far);
}

/** 逐级缩字号直到每行都放得下，且总高度不超盒高。 */
function fitFont(ctx, lines, box, startSize, family) {
  let size = Math.max(8, Math.round(startSize));
  const minSize = 8;
  while (size > minSize) {
    ctx.font = `${size}px "${family}"`;
    const widest = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const totalHeight = lines.length * size * 1.25;
    if (widest <= box.w && totalHeight <= box.h * 1.05) break;
    size -= 1;
  }
  ctx.font = `${size}px "${family}"`;
  return size;
}

function drawHorizontal(ctx, lines, box, size, align) {
  const lineHeight = size * 1.25;
  const totalHeight = lines.length * lineHeight;
  // 垂直居中于原区域
  let y = box.y + (box.h - totalHeight) / 2 + lineHeight / 2;

  ctx.textBaseline = 'middle';
  for (const line of lines) {
    let x;
    if (align === 'right') {
      ctx.textAlign = 'right';
      x = box.x + box.w;
    } else if (align === 'left') {
      ctx.textAlign = 'left';
      x = box.x;
    } else {
      ctx.textAlign = 'center';
      x = box.x + box.w / 2;
    }
    ctx.fillText(line, x, y);
    y += lineHeight;
  }
}

function drawVertical(ctx, text, box, size) {
  const chars = [...text.replace(/\n/g, '')];
  const step = Math.min(size * 1.1, box.h / Math.max(1, chars.length));
  const totalHeight = chars.length * step;
  let y = box.y + (box.h - totalHeight) / 2 + step / 2;
  const x = box.x + box.w / 2;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const ch of chars) {
    ctx.fillText(ch, x, y);
    y += step;
  }
}

/**
 * @param {{imageBuffer:Buffer, changes:Array, quality?:number}} input
 *   changes: [{modified, box:{x,y,w,h}, alignmentMode?, isVertical?, fontSize?}]
 * @returns {Promise<{buffer:Buffer, mime:string, width:number, height:number, notes:string[]}>}
 */
export async function render({ imageBuffer, changes, quality = JPEG_QUALITY }) {
  const family = ensureFont();
  const image = await decode(imageBuffer);
  const canvasSize = { width: image.width, height: image.height };

  const canvas = createCanvas(canvasSize.width, canvasSize.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);

  const notes = [];
  for (const [index, change] of changes.entries()) {
    const raw = change.box ?? change;
    const box = {
      x: Math.max(0, Math.round(Number(raw.x))),
      y: Math.max(0, Math.round(Number(raw.y))),
      w: Math.round(Number(raw.w)),
      h: Math.round(Number(raw.h)),
    };
    box.w = Math.min(box.w, canvasSize.width - box.x);
    box.h = Math.min(box.h, canvasSize.height - box.y);
    if (!(box.w > 0) || !(box.h > 0)) {
      notes.push(`第 ${index + 1} 处坐标越界，已跳过`);
      continue;
    }

    const text = String(change.modified ?? '').trim();
    if (!text) {
      notes.push(`第 ${index + 1} 处新文案为空，已跳过`);
      continue;
    }

    const background = detectBackground(ctx, box, canvasSize);
    const textColor = detectTextColor(ctx, box, background);

    // 盖掉旧文字：多留 1px 吃掉抗锯齿边缘
    ctx.fillStyle = rgb(background);
    ctx.fillRect(box.x - 1, box.y - 1, box.w + 2, box.h + 2);

    ctx.fillStyle = rgb(textColor);
    const lines = text.split('\n').filter(Boolean);
    const startSize = Number(change.fontSize) > 0 ? Number(change.fontSize) : box.h * 0.8;

    if (change.isVertical === true) {
      ctx.font = `${Math.max(8, Math.round(Math.min(box.w * 0.9, startSize)))}px "${family}"`;
      drawVertical(ctx, text, box, Math.max(8, Math.round(Math.min(box.w * 0.9, startSize))));
    } else {
      const size = fitFont(ctx, lines, box, startSize, family);
      if (size < startSize * 0.6) notes.push(`第 ${index + 1} 处新文案较长，字号已缩小到 ${size}px`);
      drawHorizontal(ctx, lines, box, size, change.alignmentMode ?? 'center');
    }
  }

  return {
    buffer: await canvas.encode('jpeg', quality),
    mime: 'image/jpeg',
    width: canvasSize.width,
    height: canvasSize.height,
    notes,
  };
}
