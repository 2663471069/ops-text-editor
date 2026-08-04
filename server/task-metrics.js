const MIN_VALID_DURATION_MS = 30_000;
const MAX_VALID_DURATION_MS = 25 * 60 * 1000;

export const DEFAULT_IMAGE_ESTIMATE = Object.freeze({
  minMs: 5 * 60 * 1000,
  maxMs: 15 * 60 * 1000,
  samples: 0,
});

function quantile(sorted, ratio) {
  const index = Math.round((sorted.length - 1) * ratio);
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

export function estimateDurationRange(durations) {
  const valid = (durations ?? [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= MIN_VALID_DURATION_MS && value <= MAX_VALID_DURATION_MS)
    .sort((a, b) => a - b);

  if (valid.length < 3) return { ...DEFAULT_IMAGE_ESTIMATE, samples: valid.length };

  const low = quantile(valid, 0.2);
  const high = quantile(valid, 0.8);
  const padding = Math.max(60_000, Math.round((high - low) * 0.25));
  return {
    minMs: Math.max(60_000, low - padding),
    maxMs: Math.min(MAX_VALID_DURATION_MS, high + padding),
    samples: valid.length,
  };
}

export function parseCompletedCodexDurations(text) {
  const durations = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.status === 'completed' && event.provider === 'codex') durations.push(Number(event.elapsedMs));
    } catch {
      // 忽略被截断或旧版本留下的异常日志行。
    }
  }
  return durations.filter((value) => Number.isFinite(value)).slice(-200);
}
