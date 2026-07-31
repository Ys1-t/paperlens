function assertCanvasSize(width, height) {
  if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
}

export function getReadOptimized2dContext(canvas, options = {}) {
  if (!canvas?.getContext) throw new TypeError('Canvas is required');
  return canvas.getContext('2d', { ...options, willReadFrequently: true });
}

export function createReadOptimizedCanvasFactory(ownerDocument) {
  return {
    // PDF.js 3.x genericComposeSMask calls getImageData on intermediate canvases.
    // Always opt into willReadFrequently so Edge/Chrome stop performance warnings;
    // the third argument is kept for API compatibility with PDF.js CachedCanvases.
    create(width, height, _willReadFrequently = true) {
      assertCanvasSize(width, height);
      const canvas = ownerDocument.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = getReadOptimized2dContext(canvas);
      if (!context) throw new Error('Unable to create a 2D canvas context');
      return { canvas, context };
    },

    reset(canvasAndContext, width, height) {
      if (!canvasAndContext?.canvas) throw new Error('Canvas is not specified');
      assertCanvasSize(width, height);
      canvasAndContext.canvas.width = width;
      canvasAndContext.canvas.height = height;
    },

    destroy(canvasAndContext) {
      if (!canvasAndContext?.canvas) throw new Error('Canvas is not specified');
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
      canvasAndContext.canvas = null;
      canvasAndContext.context = null;
    },
  };
}
