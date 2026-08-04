// OCR 适配层。各家供应商的原始返回在此统一成 {text,x,y,w,h,fontSize,isVertical,zIndex}，
// 并集中做过滤/排序——对应原规格「OCR adapter：把 polygon/ItemPolygon 转为 {text,x,y,w,h}，
// 过滤无效和过小区域」。业务层不依赖任何厂商 SDK。

import { detect as tencentDetect } from './tencent.js';
import { detect as baiduDetect } from './baidu.js';
import { detect as aliyunDetect } from './aliyun.js';
import { detect as mockDetect } from './mock.js';
import { detect as codexDetect } from './codex.js';

const PROVIDERS = {
  tencent: tencentDetect,
  baidu: baiduDetect,
  aliyun: aliyunDetect,
  mock: mockDetect,
  codex: codexDetect,
};

/** 四边形顶点 → 包围盒。顶点字段名各家不同，取 X/x 兼容。 */
export function polygonToBox(polygon) {
  const xs = polygon.map((p) => Number(p.X ?? p.x));
  const ys = polygon.map((p) => Number(p.Y ?? p.y));
  if (xs.some((n) => !Number.isFinite(n)) || ys.some((n) => !Number.isFinite(n))) return null;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// ---------- 同行合并 ----------
//
// 英文有词间空格，供应商往往按词返回框：一句 "UV GLUE CURING GUIDE" 会拆成 4-5 条，
// 根本没法当成一处文案来改。中文没有词间空格，所以中文测试时发现不了。
// 这里把垂直重叠的框归成一行、行内按 x 排序、水平间距够近的合并回一条。

const CJK_RANGES = [
  [0x3040, 0x30ff], // 日文假名
  [0x3400, 0x4dbf], // 中日韩扩展 A
  [0x4e00, 0x9fff], // 中日韩统一表意
  [0xac00, 0xd7af], // 韩文
  [0xf900, 0xfaff], // 兼容表意
  [0xff00, 0xffef], // 全角
];

function isCjk(char) {
  if (!char) return false;
  const code = char.codePointAt(0);
  return CJK_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

/** 中日韩之间不加空格，其余加一个空格。 */
function joinText(left, right) {
  if (!left) return right;
  if (!right) return left;
  const a = left.at(-1);
  const b = right[0];
  if (/\s/.test(a) || /\s/.test(b)) return left + right;
  if (isCjk(a) && isCjk(b)) return left + right;
  return `${left} ${right}`;
}

function unionBox(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * 同一行判定：拿框和「行的运行中心线」比垂直重叠，而不是和不断长大的并集比——
 * 并集会越长越高，最后把相邻行也吸进来。
 */
function onSameLine(line, box, minOverlap) {
  const lineTop = line.cy - line.h / 2;
  const lineBottom = line.cy + line.h / 2;
  const top = Math.max(lineTop, box.y);
  const bottom = Math.min(lineBottom, box.y + box.h);
  return (bottom - top) / Math.min(line.h, box.h) >= minOverlap;
}

/**
 * @param {Array<{text:string, box:object, confidence:number|null}>} items
 * @param {{minOverlap?:number, gapRatio?:number}} opts
 *   gapRatio: 水平间距 ≤ gapRatio × 行高 才合并。一个词间空格约 0.3 字高，
 *   分栏排版的列间距通常好几倍字高，所以 1.0 能合词但不会跨栏。
 */
export function mergeSameLine(items, { minOverlap = 0.5, gapRatio = 1.0 } = {}) {
  if (items.length < 2) return items;

  const lines = [];
  for (const item of [...items].sort((a, b) => a.box.y - b.box.y)) {
    const cy = item.box.y + item.box.h / 2;
    const line = lines.find((candidate) => onSameLine(candidate, item.box, minOverlap));
    if (line) {
      line.items.push(item);
      // 运行均值，避免个别大字号把整行的判定基准带偏
      line.cy = (line.cy * (line.items.length - 1) + cy) / line.items.length;
      line.h = (line.h * (line.items.length - 1) + item.box.h) / line.items.length;
    } else {
      lines.push({ items: [item], cy, h: item.box.h });
    }
  }

  const finish = (run) => ({
    text: run.text,
    box: run.box,
    confidence: run.confidences.every((c) => c == null)
      ? null
      : Math.min(...run.confidences.filter((c) => c != null)),
  });

  const out = [];
  for (const line of lines.sort((a, b) => a.cy - b.cy)) {
    line.items.sort((a, b) => a.box.x - b.box.x); // 行内按阅读顺序，修掉「同行差 2px 就乱序」
    let run = null;
    for (const item of line.items) {
      if (!run) {
        run = { text: item.text, box: { ...item.box }, confidences: [item.confidence] };
        continue;
      }
      const gap = item.box.x - (run.box.x + run.box.w);
      const scale = Math.min(run.box.h, item.box.h);
      if (gap <= scale * gapRatio) {
        run.text = joinText(run.text, item.text);
        run.box = unionBox(run.box, item.box);
        run.confidences.push(item.confidence);
      } else {
        out.push(finish(run));
        run = { text: item.text, box: { ...item.box }, confidences: [item.confidence] };
      }
    }
    if (run) out.push(finish(run));
  }
  return out;
}

function overlapRatio(box, rect) {
  const ix = Math.max(0, Math.min(box.x + box.w, rect.x + rect.w) - Math.max(box.x, rect.x));
  const iy = Math.max(0, Math.min(box.y + box.h, rect.y + rect.h) - Math.max(box.y, rect.y));
  const inter = ix * iy;
  const area = box.w * box.h;
  return area > 0 ? inter / area : 0;
}

/**
 * 归一化 + 过滤 + 编号。
 * @param {Array} raw 各 adapter 输出的 {text, box:{x,y,w,h}, confidence?}
 * @param {{width:number,height:number}} canvas
 * @param {{minAreaPercent?:number, excludeRects?:Array}} opts minAreaPercent 单位为 %（占整幅面积）
 */
export function normalizeElements(raw, canvas, { minAreaPercent = 0.05, excludeRects = [], mergeLines = true } = {}) {
  const canvasArea = canvas.width * canvas.height;
  const minArea = (canvasArea * minAreaPercent) / 100;

  const candidates = [];
  for (const item of raw) {
    const text = String(item.text ?? '').trim();
    if (!text) continue; // 丢空文本
    const box = item.box;
    if (!box || !(box.w > 0) || !(box.h > 0)) continue; // 丢非正宽高

    // 裁到画布内，避免供应商返回越界坐标
    const x = Math.max(0, Math.min(box.x, canvas.width));
    const y = Math.max(0, Math.min(box.y, canvas.height));
    const w = Math.min(box.w, canvas.width - x);
    const h = Math.min(box.h, canvas.height - y);
    if (!(w > 0) || !(h > 0)) continue;
    if (w * h < minArea) continue; // 丢过小区域

    // excludeRects 只用于 OCR 过滤，不参与文案生成
    if (excludeRects.some((rect) => overlapRatio({ x, y, w, h }, rect) > 0.5)) continue;

    candidates.push({
      text,
      box: { x, y, w, h },
      confidence: Number.isFinite(item.confidence) ? item.confidence : null,
    });
  }

  // 合并后已经是「行按 y、行内按 x」的阅读顺序；不合并时退回同样规则排序，
  // 但要给 y 一个容差，否则同一行差 2px 就会把左右顺序颠倒。
  const merged = mergeLines ? mergeSameLine(candidates) : sortReadingOrder(candidates);

  return merged.map((item, index) => {
    const { x, y, w, h } = item.box;
    const isVertical = h > w * 1.6 && item.text.length > 1;
    return {
      text: item.text,
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
      fontSize: Math.round(isVertical ? w : h),
      isVertical,
      confidence: item.confidence,
      zIndex: index,
    };
  });
}

/** 不合并时的排序：按行分带（容差取中位行高的一半），带内按 x。 */
function sortReadingOrder(items) {
  if (items.length < 2) return items;
  const heights = items.map((i) => i.box.h).sort((a, b) => a - b);
  const tolerance = Math.max(1, heights[Math.floor(heights.length / 2)] * 0.5);
  return [...items].sort((a, b) => {
    const bandA = Math.round((a.box.y + a.box.h / 2) / tolerance);
    const bandB = Math.round((b.box.y + b.box.h / 2) / tolerance);
    return bandA - bandB || a.box.x - b.box.x;
  });
}

/**
 * 按配置调用对应供应商。
 * @returns {Promise<{elements:Array, canvas:object, rawCount:number, provider:string}>}
 */
export async function detectText({ provider, credentials, imageBase64Body, canvas, minAreaPercent, excludeRects }) {
  const impl = PROVIDERS[provider];
  if (!impl) throw new Error(`未知的 OCR 服务商 ${provider}`);

  const raw = await impl({ credentials, imageBase64Body, canvas });
  const elements = normalizeElements(raw, canvas, { minAreaPercent, excludeRects });
  return { elements, canvas, rawCount: raw.length, provider };
}

export { PROVIDERS };
