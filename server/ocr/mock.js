// 假 OCR：没有任何密钥时也能把界面和全流程点一遍。
// 按图片比例摆几个框，文字带「示例」字样，不会被误认为真识别结果。

const LAYOUT = [
  { text: '示例标题文字', xr: 0.12, yr: 0.08, wr: 0.62, hr: 0.075 },
  { text: '示例副标题 · 可以改我', xr: 0.12, yr: 0.19, wr: 0.5, hr: 0.042 },
  { text: '全场五折', xr: 0.12, yr: 0.44, wr: 0.34, hr: 0.09 },
  { text: '活动时间 3月1日-3月15日', xr: 0.12, yr: 0.86, wr: 0.56, hr: 0.035 },
];

export async function detect({ canvas }) {
  return LAYOUT.map((item) => ({
    text: item.text,
    confidence: 99,
    box: {
      x: Math.round(item.xr * canvas.width),
      y: Math.round(item.yr * canvas.height),
      w: Math.round(item.wr * canvas.width),
      h: Math.round(item.hr * canvas.height),
    },
  }));
}
