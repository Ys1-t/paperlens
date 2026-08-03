export function rejectCancelledRequest(handlers, id) {
  const handler = handlers.get(id);
  if (!handler) return false;
  handlers.delete(id);
  handler.reject(Object.assign(new Error('已取消'), { cancelled: true }));
  return true;
}

export function createRequestRecord() {
  return { cancelled: false, controller: null };
}

export function cancelRequestRecord(record) {
  if (!record) return false;
  record.cancelled = true;
  record.controller?.abort?.();
  return true;
}

export function startPageRequest(page) {
  const previousRequestId = page.trId ?? null;
  const replacedActive = page.translationActive === true;
  const generation = (Number(page.renderGeneration) || 0) + 1;
  page.renderGeneration = generation;
  page.translationActive = true;
  page.trId = null;
  return { generation, previousRequestId, replacedActive };
}

export function settlePageRequest(page, generation) {
  if (page.renderGeneration !== generation || page.translationActive !== true) return false;
  page.translationActive = false;
  page.trId = null;
  return true;
}

export function createRenderFrameGate(requestFrame, cancelFrame, onFrame) {
  let frameId = null;
  return {
    schedule() {
      if (frameId !== null) return false;
      frameId = requestFrame(() => {
        frameId = null;
        onFrame();
      });
      return true;
    },
    cancel() {
      if (frameId === null) return false;
      cancelFrame(frameId);
      frameId = null;
      return true;
    },
    get pending() { return frameId !== null; },
  };
}

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 502, 503, 504]);
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETDOWN', 'ENETUNREACH',
  'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

export function isTransientFetchError(error) {
  if (!error || error.cancelled === true || error.name === 'AbortError') return false;
  if (TRANSIENT_HTTP_STATUSES.has(Number(error.status))) return true;

  const code = String(error.code || error.cause?.code || '').toUpperCase();
  if (TRANSIENT_NETWORK_CODES.has(code)) return true;

  // Browser fetch rejects transport failures with TypeError. Keep the message
  // check narrow so programming TypeErrors are never replayed.
  const message = `${error.message || ''} ${error.cause?.message || ''}`.toLowerCase();
  const looksLikeFetchFailure = (
    message.includes('failed to fetch')
    || message.includes('fetch failed')
    || message.includes('networkerror')
    || message.includes('network request failed')
    || message.includes('load failed')
  );
  return (error instanceof TypeError || error.name === 'NetworkError') && looksLikeFetchFailure;
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('Aborted', 'AbortError');
}

function waitForRetry(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const delay = Math.max(0, Number(delayMs) || 0);
  if (delay === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Run an operation at most twice, replaying only a proven transient failure. */
export async function retryTransientOnce(
  operation,
  { signal, delayMs = 150, shouldRetry, onRetry } = {},
) {
  try {
    return await operation(0);
  } catch (error) {
    if (signal?.aborted) {
      // Preserve the transport/body reader's concrete AbortError when it has
      // one; callers use its identity to distinguish cancellation sources.
      if (error?.name === 'AbortError') throw error;
      throw abortReason(signal);
    }
    const permitted = typeof shouldRetry === 'function'
      ? shouldRetry(error)
      : isTransientFetchError(error);
    if (!permitted || !isTransientFetchError(error)) throw error;
    onRetry?.(error);
    // delayMs 可以是函数：按错误类型定制退避（如 429 用更长间隔）。
    const delay = typeof delayMs === 'function' ? delayMs(error) : delayMs;
    await waitForRetry(delay, signal);
    if (signal?.aborted) throw abortReason(signal);
    return operation(1);
  }
}
