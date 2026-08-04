// 任务存储。
//
// 原规格 DATA-MODELS.md 的 TextEditTask 没有任何归属字段，但 README 和 TEST-CHECKLIST 都要求
// 「任务查询必须校验用户或租户归属，不能仅凭 taskId 越权读取」——数据模型撑不起它自己的安全要求。
// 这里把 ownerId 设为必填，并把归属校验下沉到 store：路由层就算忘了传也拿不到别人的任务。
//
// 进程内 Map 仅适用于单机；生产环境换 Redis/数据库时保持同样的 get(id, ownerId) 签名即可。

import { randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 完成 1 小时后清理，避免 base64 结果常驻内存

export function createTaskStore({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const tasks = new Map();

  function sweep() {
    const cutoff = now() - ttlMs;
    for (const [id, task] of tasks) {
      const done = task.completedAt ?? task.failedAt;
      if (done && done < cutoff) tasks.delete(id);
    }
  }

  function create({ ownerId, prompt, action = '文案修改', inputImageRef, meta }) {
    if (!ownerId) throw new Error('ownerId is required'); // 硬性要求，不允许匿名任务
    sweep();
    const task = {
      id: randomUUID(),
      traceId: `trace-${randomUUID().slice(0, 8)}`,
      ownerId: String(ownerId),
      status: 'processing',
      action,
      prompt,
      inputImageRef,
      meta: meta ?? null,
      data: null,
      error: null,
      resultMode: null,
      createdAt: now(),
      completedAt: null,
      failedAt: null,
    };
    tasks.set(task.id, task);
    return task;
  }

  /** 找不到和不属于该 owner 都返回 null——不泄露任务是否存在。 */
  function get(id, ownerId) {
    const task = tasks.get(String(id));
    if (!task) return null;
    if (!ownerId || task.ownerId !== String(ownerId)) return null;
    return task;
  }

  function complete(id, data, { resultMode = 'url' } = {}) {
    const task = tasks.get(String(id));
    if (!task || task.status !== 'processing') return null;
    task.status = 'completed';
    task.data = Array.isArray(data) ? data : [data];
    task.resultMode = resultMode;
    task.completedAt = now();
    return task;
  }

  function fail(id, error) {
    const task = tasks.get(String(id));
    if (!task || task.status !== 'processing') return null;
    task.status = 'failed';
    task.error = typeof error === 'string' ? error : (error?.message ?? '任务执行失败');
    task.failedAt = now();
    return task;
  }

  /** 对外视图：不含 ownerId、prompt、meta 等内部字段。 */
  function toPublic(task) {
    const endedAt = task.completedAt ?? task.failedAt;
    return {
      status: task.status,
      data: task.data,
      error: task.error,
      traceId: task.traceId,
      resultMode: task.resultMode,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
      failedAt: task.failedAt,
      elapsedMs: endedAt ? endedAt - task.createdAt : now() - task.createdAt,
    };
  }

  return { create, get, complete, fail, toPublic, size: () => tasks.size };
}
