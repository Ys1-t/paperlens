// src/lib/inactivity-guard.js
// 无活动超时守卫（纯逻辑、计时器可注入，便于单测）。viewer 的三条翻译路径共用。
//
// 窗口语义（v0.8.21 修复 P1「翻译超时（无响应）」误杀）：
// - 创建即按 firstMs 计时：这是「首字节窗口」，度量从请求发出到第一个正文字节
//   （chunk 或 status:streaming）之间允许的静默上限。
// - bump()：「请求活着但还没有正文」的信号（status:connecting / thinking 心跳 /
//   queued 恢复后的任何状态）。首字节到达前只把 firstMs 完整窗口重新计时，
//   绝不压缩成 idleMs——旧实现任何活动都切到 45s 空闲窗口，而任务一启动 SW
//   就回 connecting，推理模型思考期只要 45s 没有新消息就被误杀。
// - output()：第一个正文字节（chunk / status:streaming）到达时调用，此后进入
//   idleMs 空闲窗口；流式输出中断超过 idleMs 才算超时。
// - hold()：排队中停表（排队不算无响应）。但停表有 holdMaxMs 兜底：Port 瞬断时
//   SW 的 post() 会静默吞掉发送异常，后续状态消息可能永远不来；没有兜底页面会
//   永远停在「排队中…」。默认 450s = 排队死线 240s（NORMAL_QUEUE_TIMEOUT_MS）
//   + SW 单请求硬超时 180s（REQUEST_TIMEOUT_MS）+ 30s 余量。
// - done()：请求已收尾（done/error/cancelled），守卫永久失效。

export const GUARD_FIRST_WINDOW_MS = 90000;
export const GUARD_IDLE_WINDOW_MS = 45000;
export const GUARD_HOLD_MAX_MS = 450000;

export function makeInactivityGuard(onTimeout, {
  firstMs = GUARD_FIRST_WINDOW_MS,
  idleMs = GUARD_IDLE_WINDOW_MS,
  holdMaxMs = GUARD_HOLD_MAX_MS,
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn = (id) => clearTimeout(id),
} = {}) {
  let settled = false;
  let outputStarted = false;
  let timer = null;
  let holdTimer = null;

  const fire = () => {
    if (settled) return;
    settled = true;
    timer = null;
    holdTimer = null;
    onTimeout();
  };
  const clearMain = () => {
    if (timer != null) { clearTimeoutFn(timer); timer = null; }
  };
  const clearHold = () => {
    if (holdTimer != null) { clearTimeoutFn(holdTimer); holdTimer = null; }
  };
  const arm = (ms) => {
    clearHold();
    clearMain();
    timer = setTimeoutFn(fire, ms);
  };

  arm(firstMs);
  return {
    // 活跃但尚无正文：首字节前重置完整 firstMs 窗口（证明请求活着，但不缩窗）；
    // 首字节后按普通活动续 idleMs。
    bump() { if (!settled) arm(outputStarted ? idleMs : firstMs); },
    // 首个正文字节（chunk 或 status:streaming）：从此切换到 idleMs 空闲窗口。
    output() {
      if (settled) return;
      outputStarted = true;
      arm(idleMs);
    },
    // 排队中：停表。holdMaxMs 兜底——停表后完全静默超过上限仍按超时处理。
    // 重复 hold 不重置兜底计时（死线从第一次进入排队开始算）。
    hold() {
      if (settled) return;
      clearMain();
      if (holdTimer == null && Number(holdMaxMs) > 0) holdTimer = setTimeoutFn(fire, holdMaxMs);
    },
    done() {
      settled = true;
      clearMain();
      clearHold();
    },
    get settled() { return settled; },
    get outputStarted() { return outputStarted; },
  };
}
