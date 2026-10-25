import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

/** Compare decoded pixels at the same display size. PSNR is a regression guard, not a human quality verdict. */
export async function verifyImageQuality(browser, origin, output, engine) {
  const bytes = await readFile('build-work/image-quality/apollo17.jpg');
  const source = JSON.parse(await readFile('build-work/image-quality/source.json', 'utf8'));
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await page.goto(origin + '/admin');
    const result = await page.evaluate(async (base64) => {
      const binary = atob(base64), bytes = new Uint8Array(binary.length);
      for (let n = 0; n < binary.length; n++) bytes[n] = binary.charCodeAt(n);
      const file = new File([bytes], 'apollo17.jpg', { type: 'image/jpeg' });
      const variants = await new Promise((resolve, reject) => {
        const worker = new Worker('/image.worker.js', { type: 'module' });
        const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Photo optimizer timeout')); }, 30000);
        worker.onmessage = ({ data }) => { clearTimeout(timeout); worker.terminate(); resolve(data); };
        worker.onerror = () => { clearTimeout(timeout); worker.terminate(); reject(new Error('Photo optimizer failed')); };
        worker.postMessage(file);
      });
      const bitmap = await createImageBitmap(file);
      const results = [];
      const previews = [];
      for (const item of variants) {
        const decoded = await createImageBitmap(item.blob);
        const reference = document.createElement('canvas');
        reference.width = decoded.width; reference.height = decoded.height;
        const a = reference.getContext('2d');
        a.drawImage(bitmap, 0, 0, decoded.width, decoded.height);
        const candidate = document.createElement('canvas');
        candidate.width = decoded.width; candidate.height = decoded.height;
        const b = candidate.getContext('2d'); b.drawImage(decoded, 0, 0);
        const before = a.getImageData(0, 0, decoded.width, decoded.height).data;
        const after = b.getImageData(0, 0, decoded.width, decoded.height).data;
        let squared = 0;
        for (let n = 0; n < before.length; n++) if (n % 4 !== 3) squared += (before[n] - after[n]) ** 2;
        const mse = squared / (decoded.width * decoded.height * 3);
        results.push({ width: decoded.width, height: decoded.height, bytes: item.blob.size, psnrDb: mse === 0 ? 100 : 10 * Math.log10(255 ** 2 / mse) });
        if (item.width === 640) previews.push(reference.toDataURL(), candidate.toDataURL());
        decoded.close();
      }
      bitmap.close();
      document.body.replaceChildren();
      const heading = document.createElement('h1'); heading.textContent = 'NASA Apollo 17 · Original / WebP 0.82 (640px)';
      document.body.append(heading);
      for (const url of previews) { const img = document.createElement('img'); img.src = url; img.width = 640; document.body.append(img); await img.decode(); }
      return results;
    }, bytes.toString('base64'));
    assert.deepEqual(result.map((item) => item.width), [640, 1280, 1920]);
    for (const item of result) {
      assert.ok(item.psnrDb >= 28, engine + ' photo quality regression: ' + item.psnrDb);
      assert.ok(item.bytes < bytes.length * 0.85);
    }
    await page.screenshot({ path: resolve(output, 'image-photo-quality-' + engine + '.png'), fullPage: true });
    const report = { source, engine, results: result, method: 'PSNR against browser-resized source at each derivative width; no subjective quality claim; no field network claim' };
    await writeFile(resolve(output, 'image-photo-quality-' + engine + '.json'), JSON.stringify(report, null, 2));
    console.log('IMAGE_PHOTO_QUALITY ' + JSON.stringify(report));
  } finally { await context.close(); }
}
