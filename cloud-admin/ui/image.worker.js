import { imageInfo } from '../src/image-info.ts';

self.onmessage = async ({ data: file }) => {
  let bitmap;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer()), info = imageInfo(bytes);
    const variants = [];
    // Preserve animations/unknown formats and avoid allocating oversized decoded surfaces.
    if (!info.width || info.animated || info.width * info.height > 24_000_000 ||
        file.size < 80_000 || !self.OffscreenCanvas || !self.createImageBitmap) {
      self.postMessage(variants); return;
    }
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    for (const width of [640, 1280, 1920]) {
      if (width > bitmap.width) continue;
      const height = Math.max(1, Math.round(bitmap.height * width / bitmap.width));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) break;
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
      // Some engines silently fall back to PNG. Never label these bytes WebP.
      if (blob.type === 'image/webp' && blob.size < file.size * 0.85 && blob.size <= 2_000_000)
        variants.push({ width, blob });
      canvas.width = canvas.height = 1;
    }
    self.postMessage(variants);
  } catch { self.postMessage([]); }
  finally { bitmap?.close(); }
};
