function uniqueInRange(indices, pageCount) {
  const seen = new Set();
  return indices.filter((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= pageCount || seen.has(index)) return false;
    seen.add(index);
    return true;
  });
}

export function buildPagePriorityOrder(currentIndex, pageCount) {
  if (!Number.isInteger(currentIndex) || !Number.isInteger(pageCount) || pageCount <= 0) return [];
  return uniqueInRange(
    [currentIndex, currentIndex - 1, currentIndex + 1, currentIndex + 2, currentIndex + 3],
    pageCount,
  );
}

function abortError(reason = 'Page task cancelled') {
  if (reason && reason.name === 'AbortError') return reason;
  if (typeof DOMException === 'function') return new DOMException(String(reason), 'AbortError');
  const error = new Error(String(reason));
  error.name = 'AbortError';
  return error;
}

export function createPageScheduler({ concurrency = 2 } = {}) {
  const maxConcurrency = Math.max(1, Number.isInteger(concurrency) ? concurrency : 2);
  const entries = new Set();
  const queue = [];
  let running = 0;
  let sequence = 0;

  const removeQueued = (entry) => {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
  };

  const cleanup = (entry) => {
    entry.externalSignal?.removeEventListener('abort', entry.onExternalAbort);
    entries.delete(entry);
  };

  const cancelEntry = (entry, reason) => {
    const error = abortError(reason);
    if (!entry.controller.signal.aborted) entry.controller.abort(error);
    if (entry.state === 'running') {
      if (!entry.invoked) {
        entry.state = 'cancelled';
        cleanup(entry);
        entry.reject(error);
        return;
      }
      cleanup(entry);
      return;
    }
    if (entry.state !== 'queued') return;
    removeQueued(entry);
    entry.state = 'cancelled';
    cleanup(entry);
    entry.reject(error);
  };

  const pump = () => {
    while (running < maxConcurrency && queue.length) {
      queue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
      const entry = queue.shift();
      if (!entry || entry.state !== 'queued') continue;
      entry.state = 'running';
      running += 1;
      Promise.resolve()
        .then(() => {
          if (entry.state === 'cancelled' || entry.controller.signal.aborted) {
            throw abortError(entry.controller.signal.reason);
          }
          entry.invoked = true;
          return entry.taskFn({
            pageIndex: entry.pageIndex,
            generation: entry.generation,
            signal: entry.controller.signal,
            priority: entry.priority,
          });
        })
        .then((value) => {
          entry.state = 'settled';
          running -= 1;
          cleanup(entry);
          pump();
          entry.resolve(value);
        }, (error) => {
          entry.state = 'settled';
          running -= 1;
          cleanup(entry);
          pump();
          entry.reject(error);
        });
    }
  };

  return {
    schedule(pageIndex, taskFn, { priority = 0, signal, generation = 0 } = {}) {
      if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        throw new RangeError('pageIndex must be a non-negative integer');
      }
      if (typeof taskFn !== 'function') throw new TypeError('taskFn must be a function');

      const existing = [...entries].find(
        (entry) => entry.pageIndex === pageIndex && entry.generation === generation,
      );
      if (existing) {
        if (existing.state === 'queued' && Number.isFinite(priority)) {
          existing.priority = Math.min(existing.priority, priority);
          pump();
        }
        return existing.promise;
      }

      if (signal?.aborted) return Promise.reject(abortError(signal.reason));

      const controller = new AbortController();
      const entry = {
        pageIndex,
        taskFn,
        priority: Number.isFinite(priority) ? priority : 0,
        generation,
        controller,
        externalSignal: signal,
        sequence: sequence++,
        state: 'queued',
        invoked: false,
      };
      entry.promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      entry.onExternalAbort = () => cancelEntry(entry, signal.reason);
      signal?.addEventListener('abort', entry.onExternalAbort, { once: true });

      entries.add(entry);
      queue.push(entry);
      pump();
      return entry.promise;
    },

    cancelGeneration(generation, reason = 'Page generation cancelled') {
      for (const entry of [...entries]) {
        if (entry.generation === generation) cancelEntry(entry, reason);
      }
    },

    cancelAll(reason = 'Page scheduler cancelled') {
      for (const entry of [...entries]) cancelEntry(entry, reason);
    },

    pump,
  };
}
