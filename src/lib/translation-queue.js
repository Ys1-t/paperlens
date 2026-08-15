// 正文请求的排队死线（v0.8.21 从 60s 提升）。并发槽位（默认 4）可能被慢请求
// 合法占满：SW 单请求硬超时为 180s，因此排到队头的请求最多要等完一个完整慢
// 请求周期。取 REQUEST_TIMEOUT_MS(180s) + 60s 缓冲 = 240s：简单、可预测。
// 排队等待期间 viewer 守卫处于 hold 停表状态，不会把排队误判为模型超时；
// 这条死线只是队列无限增长时的最终保险，必须存在且有限。
export const NORMAL_QUEUE_TIMEOUT_MS = 240000;

export function createTranslationScheduler(getMaxNormal) {
  const normalQueue = [];
  const formulaQueue = [];
  let normalRunning = 0;
  let formulaRunning = 0;
  let sequence = 0;

  const removeQueued = (queue, job) => {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
  };

  const launch = (job, formula) => {
    clearTimeout(job.queueTimer);
    job.state = 'running';
    if (formula) formulaRunning++;
    else normalRunning++;
    Promise.resolve()
      .then(job.taskFn)
      .then(job.resolve, job.reject)
      .finally(() => {
        if (formula) formulaRunning--;
        else normalRunning--;
        pump();
      });
  };

  const pump = () => {
    const maxNormal = Math.max(1, Number(getMaxNormal()) || 1);
    normalQueue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
    formulaQueue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
    while (normalRunning < maxNormal && normalQueue.length) launch(normalQueue.shift(), false);
    while (formulaRunning < 1 && formulaQueue.length) launch(formulaQueue.shift(), true);
  };

  return {
    schedule(taskFn, {
      formula = false,
      priority = 0,
      queueTimeoutMs = formula ? 0 : NORMAL_QUEUE_TIMEOUT_MS,
    } = {}) {
      return new Promise((resolve, reject) => {
        const queue = formula ? formulaQueue : normalQueue;
        const job = {
          taskFn,
          resolve,
          reject,
          priority: Number.isFinite(priority) ? priority : 0,
          sequence: sequence++,
          state: 'queued',
          queueTimer: null,
        };
        if (Number(queueTimeoutMs) > 0) {
          job.queueTimer = setTimeout(() => {
            if (job.state !== 'queued') return;
            job.state = 'timed-out';
            removeQueued(queue, job);
            // 文案必须与模型响应超时可区分（那边是「请求超时/模型响应较慢」），便于诊断。
            const error = new Error(`排队等待超时（${Math.ceil(Number(queueTimeoutMs) / 1000)}s）：前方翻译任务较多，请稍后重试本页`);
            error.code = 'translation_queue_timeout';
            reject(error);
          }, Number(queueTimeoutMs));
        }
        queue.push(job);
        pump();
      });
    },
    isSaturated({ formula = false } = {}) {
      return formula ? formulaRunning >= 1 : normalRunning >= Math.max(1, Number(getMaxNormal()) || 1);
    },
    pump,
  };
}
