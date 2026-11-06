import { imageInfo } from '../src/image-info.ts';

self.onmessage = async ({ data }) => {
  const compact = data?.compact === true;
  const file = compact ? data.file : data;
  let bitmap;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer()),
      info = imageInfo(bytes);
    const variants = [];
    // Preserve animations/unknown formats and avoid allocating oversized decoded surfaces.
    if (
      !info.width ||
      info.animated ||
      info.width * info.height > 24_000_000 ||
      file.size < 80_000 ||
      !self.OffscreenCanvas ||
      !self.createImageBitmap
    ) {
      self.postMessage(variants);
      return;
    }
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    let main;
    if (compact) {
      const width = Math.min(1920, bitmap.width);
      const canvas = new OffscreenCanvas(
        width,
        Math.max(1, Math.round((bitmap.height * width) / bitmap.width)),
      );
      const context = canvas.getContext('2d');
      if (context) {
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const candidate = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
        if (candidate.type === 'image/webp' && candidate.size < file.size * 0.85) main = candidate;
      }
      canvas.width = canvas.height = 1;
      if (!main) {
        self.postMessage([]);
        return;
      }
    }
    let total = main?.size || 0;
    for (const width of [640, 1280, 1920]) {
      if (compact && width >= Math.min(1920, bitmap.width)) continue;
      if (width > bitmap.width) continue;
      const height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) break;
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
      // Some engines silently fall back to PNG. Never label these bytes WebP.
      if (
        blob.type === 'image/webp' &&
        blob.size < (main?.size || file.size) * 0.85 &&
        blob.size <= 2_000_000 &&
        (!compact || total + blob.size < file.size)
      ) {
        variants.push({ width, blob });
        total += blob.size;
      }
      canvas.width = canvas.height = 1;
    }
    self.postMessage(compact ? { main, variants } : variants);
  } catch {
    self.postMessage([]);
  } finally {
    bitmap?.close();
  }
};
