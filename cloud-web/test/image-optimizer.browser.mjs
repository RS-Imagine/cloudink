import assert from 'node:assert/strict';

/** Fixed seed, textured RGB landscape; generated identically for all before/after runs. */
export async function largeImage(page) {
  return Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 2048;
      canvas.height = 1536;
      const ctx = canvas.getContext('2d'),
        pixels = ctx.createImageData(canvas.width, canvas.height);
      let seed = 42;
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          const at = (y * canvas.width + x) * 4;
          for (let channel = 0; channel < 3; channel++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const base = [50 + x / 20, 90 + y / 30, 180 - y / 25][channel];
            pixels.data[at + channel] = base + ((seed >>> 24) & 63);
          }
          pixels.data[at + 3] = 255;
        }
      ctx.putImageData(pixels, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    }),
    'base64',
  );
}
export async function verifyImageOptimizer(browser, origin) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await page.goto(origin + '/admin');
    const result = await page.evaluate(async () => {
      const optimize = (file) =>
        new Promise((resolve, reject) => {
          const worker = new Worker('/image.worker.js', { type: 'module' });
          const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error('Optimizer timed out'));
          }, 15000);
          worker.onmessage = ({ data }) => {
            clearTimeout(timer);
            worker.terminate();
            resolve(data);
          };
          worker.onerror = (error) => {
            clearTimeout(timer);
            worker.terminate();
            reject(new Error(error.message));
          };
          worker.postMessage(file);
        });
      const canvas = document.createElement('canvas');
      canvas.width = 1400;
      canvas.height = 900;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#345678';
      ctx.fillRect(0, 0, 700, 900);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      // Padding is after PNG IEND; decoders ignore it. Forces the optimizer's minimum size.
      const file = new File([blob, new Uint8Array(90000)], 'alpha.png', { type: 'image/png' });
      const variants = await optimize(file),
        decoded = [];
      for (const item of variants) {
        const bitmap = await createImageBitmap(item.blob);
        const check = document.createElement('canvas');
        check.width = bitmap.width;
        check.height = bitmap.height;
        const surface = check.getContext('2d');
        surface.drawImage(bitmap, 0, 0);
        decoded.push({
          width: bitmap.width,
          height: bitmap.height,
          type: item.blob.type,
          alpha: surface.getImageData(bitmap.width - 1, 0, 1, 1).data[3],
        });
        bitmap.close();
      }
      // APNG acTL before image data: do not flatten the animation even if the first frame decodes.
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const chunk = new Uint8Array(20);
      new DataView(chunk.buffer).setUint32(0, 8);
      chunk.set([97, 99, 84, 76], 4);
      const animated = new File(
        [bytes.slice(0, 33), chunk, bytes.slice(33), new Uint8Array(90000)],
        'animated.png',
      );
      return { decoded, animatedCount: (await optimize(animated)).length };
    });
    assert.deepEqual(
      result.decoded.map((x) => x.width),
      [640, 1280],
    );
    assert.ok(result.decoded.every((x) => x.type === 'image/webp' && x.alpha === 0));
    assert.equal(result.animatedCount, 0);
  } finally {
    await context.close();
  }
}
