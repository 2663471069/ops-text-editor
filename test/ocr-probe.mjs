// OCR 供应商探测：用一张程序生成的测试海报打一次真实接口，验证密钥与坐标质量。
// 不含任何密钥，凭据从环境变量或已保存的配置读。
//
//   node test/ocr-probe.mjs                     # 用配置里已保存的服务商和密钥
//   $env:OCR_PROVIDER="aliyun"; $env:OCR_ID="..."; $env:OCR_SECRET="..."; node test/ocr-probe.mjs

import { detectText } from '../server/ocr/index.js';
import { makeProbeImage } from '../server/image/probe.js';
import { getSecrets } from '../server/config.js';

const saved = getSecrets().ocr;
const provider = process.env.OCR_PROVIDER || saved.provider;
const credentials = {
  secretId: process.env.OCR_ID || saved.secretId,
  secretKey: process.env.OCR_SECRET || saved.secretKey,
  region: process.env.OCR_REGION || saved.region,
};

const probe = await makeProbeImage();
console.log(`服务商: ${provider}`);
console.log(`测试图: ${probe.width}×${probe.height}，图上文字 → ${probe.expected.join(' / ')}\n`);

const started = Date.now();
try {
  const { elements, rawCount } = await detectText({
    provider,
    credentials,
    imageBase64Body: probe.buffer.toString('base64'),
    canvas: { width: probe.width, height: probe.height },
    minAreaPercent: 0.05,
    excludeRects: [],
  });

  console.log(`耗时 ${Date.now() - started}ms，原始 ${rawCount} 条 → 归一化后 ${elements.length} 条:\n`);
  for (const el of elements) {
    const flags = [el.isVertical ? '竖排' : null, el.confidence != null ? `prob=${el.confidence}` : null]
      .filter(Boolean)
      .join(' ');
    console.log(`  ${el.zIndex + 1}. "${el.text}"`);
    console.log(`     ${el.w}×${el.h} @ (${el.x},${el.y})  字号约${el.fontSize}px ${flags}`);
  }

  const found = elements.map((e) => e.text.replace(/\s/g, ''));
  const matched = probe.expected.filter((want) => found.some((got) => got.includes(want.slice(0, 3))));
  console.log(`\n命中 ${matched.length}/${probe.expected.length}`);
  if (provider === 'mock') console.log('注意：mock 是假数据，与图片内容无关。');
  else if (matched.length === 0) console.log('接口通了但一个字没识别出来——确认是否开通了对应的 OCR 服务。');
  else console.log('识别正常 ✓');
} catch (error) {
  console.log(`失败: ${error.message}`);
  process.exitCode = 1;
}
