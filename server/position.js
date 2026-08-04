// 像素坐标 → 中文位置描述。
//
// 这是原规格里唯一有技术含量、却只写了「应由原图像素坐标计算」而没给实现的部分。
// 描述风格必须稳定：同一个位置每次都要生成同样的话，否则出图效果会飘。

const V_BANDS = [
  [0.22, '顶部'],
  [0.4, '上方'],
  [0.6, '中部'],
  [0.78, '下方'],
  [Infinity, '底部'],
];

const H_BANDS = [
  [0.22, '最左'],
  [0.4, '左侧'],
  [0.6, '中间'],
  [0.78, '右侧'],
  [Infinity, '最右'],
];

function band(ratio, table) {
  for (const [limit, name] of table) if (ratio < limit) return name;
  return table.at(-1)[1];
}

function pct(n) {
  return `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`;
}

/**
 * @param {{x:number,y:number,w:number,h:number,isVertical?:boolean}} box 原图像素包围盒
 * @param {{width:number,height:number}} canvas 原图像素尺寸
 * @returns {string} 例：`约在画面上方中间 (参考坐标 x:50%, y:12%)`
 */
export function describePosition(box, canvas) {
  const cw = Number(canvas?.width);
  const ch = Number(canvas?.height);
  if (!Number.isFinite(cw) || !Number.isFinite(ch) || cw <= 0 || ch <= 0) {
    throw new Error('canvas 尺寸非法');
  }
  const x = Number(box?.x);
  const y = Number(box?.y);
  const w = Number(box?.w);
  const h = Number(box?.h);
  if ([x, y, w, h].some((n) => !Number.isFinite(n)) || w <= 0 || h <= 0) {
    throw new Error('包围盒非法');
  }

  const cxRatio = (x + w / 2) / cw;
  const cyRatio = (y + h / 2) / ch;
  const vName = band(cyRatio, V_BANDS);
  const hName = band(cxRatio, H_BANDS);

  // 「中部中间」读起来别扭，正中单独说。
  const where = vName === '中部' && hName === '中间' ? '正中' : `${vName}${hName}`;

  const parts = [`约在画面${where}`];

  // 通栏文字给模型一个额外提示：它的换行/对齐基准是整幅宽度。
  if (w / cw >= 0.8) parts.push('横跨画面宽度');
  else if (h / ch >= 0.6 && box.isVertical) parts.push('纵贯画面高度');

  parts.push(`(参考坐标 x:${pct(cxRatio)}, y:${pct(cyRatio)})`);
  return parts.join('，').replace('，(', ' (');
}

/** 供 UI 展示的短标签，不进提示词。 */
export function shortLabel(box, canvas) {
  const cyRatio = (Number(box.y) + Number(box.h) / 2) / Number(canvas.height);
  const cxRatio = (Number(box.x) + Number(box.w) / 2) / Number(canvas.width);
  return `${band(cyRatio, V_BANDS)}${band(cxRatio, H_BANDS)}`;
}
