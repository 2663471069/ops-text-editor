// 并发槽位。原规格伪代码在 tryAcquire 之后、taskStore.create 之前没有 try/finally，
// create 抛异常时槽位就泄漏了——而它自己的实现指南明确要求「所有异常路径都要释放并发槽位」。
// 这里把 release 做成幂等，并提供 run() 包装保证释放。

export function createQueue({ perUser = 2, globalMax = 6 } = {}) {
  if (perUser < 1 || globalMax < 1) throw new Error('并发上限必须 >= 1');
  const perUserCount = new Map();
  let globalCount = 0;

  function tryAcquire(userId) {
    const key = String(userId ?? 'anonymous');
    const mine = perUserCount.get(key) ?? 0;
    if (globalCount >= globalMax) return null;
    if (mine >= perUser) return null;

    perUserCount.set(key, mine + 1);
    globalCount += 1;

    let released = false;
    return {
      userId: key,
      release() {
        if (released) return; // 幂等：重复调用不会把计数减穿
        released = true;
        globalCount -= 1;
        const now = (perUserCount.get(key) ?? 1) - 1;
        if (now <= 0) perUserCount.delete(key);
        else perUserCount.set(key, now);
      },
      get released() {
        return released;
      },
    };
  }

  /** 拿到槽位后执行 fn，无论成功、抛错还是提前 return 都释放。 */
  async function run(userId, fn) {
    const slot = tryAcquire(userId);
    if (!slot) {
      const err = new Error('并发任务已满');
      err.statusCode = 429;
      throw err;
    }
    try {
      return await fn(slot);
    } finally {
      slot.release();
    }
  }

  function stats() {
    return { globalCount, globalMax, perUser, users: Object.fromEntries(perUserCount) };
  }

  return { tryAcquire, run, stats };
}
