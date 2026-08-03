export function createViewerSessionCleanup({
  getSnapshot,
  abortDocument,
  cancelScheduler,
  cancelRequests,
  deleteDocument,
}) {
  let cleanedGeneration = null;

  return function cleanupViewerSession() {
    const snapshot = getSnapshot();
    if (!snapshot || snapshot.generation === cleanedGeneration) return;
    cleanedGeneration = snapshot.generation;

    cancelScheduler(snapshot);
    cancelRequests(snapshot);
    abortDocument(snapshot);

    if (!snapshot.documentId) return;
    try {
      void Promise.resolve(deleteDocument(snapshot)).catch(() => {});
    } catch {
      // Unload cleanup is best-effort and must never block navigation.
    }
  };
}

export function createLatestDocumentLoader(openDocument) {
  let loadGeneration = 0;
  let controller = null;

  return {
    async run(loadDocument) {
      loadGeneration += 1;
      const generation = loadGeneration;
      controller?.abort();
      controller = new AbortController();

      try {
        const document = await loadDocument({ signal: controller.signal, generation });
        if (generation !== loadGeneration) return false;
        await openDocument(document, generation);
        return generation === loadGeneration;
      } catch (error) {
        if (generation !== loadGeneration || error?.name === 'AbortError') return false;
        throw error;
      }
    },

    cancel() {
      loadGeneration += 1;
      controller?.abort();
      controller = null;
    },
  };
}

export function isCurrentDocumentPage(
  currentDocumentGeneration,
  closedGeneration,
  page,
  expectedDocumentGeneration,
  expectedRenderGeneration,
) {
  return currentDocumentGeneration === expectedDocumentGeneration
    && closedGeneration !== expectedDocumentGeneration
    && page?.documentGeneration === expectedDocumentGeneration
    && page?.renderGeneration === expectedRenderGeneration;
}
