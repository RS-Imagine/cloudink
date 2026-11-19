const $ = (id) => document.getElementById(id);
const ICO_COMPRESS_THRESHOLD = 16 * 1024;
const iconURL = (key) =>
  /^uploads\/icons\/[a-f0-9]{64}\.(svg|ico)$/.test(key || '')
    ? '/site-icon/' + key.slice('uploads/icons/'.length)
    : '/favicon.svg';
const kb = (bytes) =>
  (bytes >= 10240 ? Math.round(bytes / 1024) : (bytes / 1024).toFixed(1)) + ' KB';

export function packPngIco(frames) {
  const headerSize = 6 + frames.length * 16;
  const totalSize = headerSize + frames.reduce((sum, frame) => sum + frame.png.byteLength, 0);
  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, frames.length, true);
  let offset = headerSize;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    output[entry] = frame.size >= 256 ? 0 : frame.size;
    output[entry + 1] = frame.size >= 256 ? 0 : frame.size;
    output[entry + 2] = 0;
    output[entry + 3] = 0;
    view.setUint16(entry + 4, 1, true);
    view.setUint16(entry + 6, 32, true);
    view.setUint32(entry + 8, frame.png.byteLength, true);
    view.setUint32(entry + 12, offset, true);
    output.set(frame.png, offset);
    offset += frame.png.byteLength;
  });
  return output;
}

async function compressLargeIco(file) {
  if (!/\.ico$/i.test(file.name) || file.size <= ICO_COMPRESS_THRESHOLD)
    return { body: file, compressed: false };
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('decode failed'));
      img.src = objectUrl;
    });
    if (!img.naturalWidth || !img.naturalHeight) return { body: file, compressed: false };
    const sizes = img.naturalWidth >= 64 ? [32, 64] : [32];
    const frames = [];
    for (const size of sizes) {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return { body: file, compressed: false };
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, size, size);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return { body: file, compressed: false };
      frames.push({ size, png: new Uint8Array(await blob.arrayBuffer()) });
    }
    const packed = packPngIco(frames);
    if (packed.byteLength >= file.size) return { body: file, compressed: false };
    return {
      body: new Blob([packed], { type: 'image/x-icon' }),
      compressed: true,
      fromBytes: file.size,
      toBytes: packed.byteLength,
    };
  } catch {
    return { body: file, compressed: false };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function configureSiteIcon({ api, notice }) {
  const input = $('site-icon-file'),
    field = $('site-icon-value'),
    preview = $('site-icon-preview');
  let generation = 0,
    pending = Promise.resolve();
  const show = () => {
    preview.src = iconURL(field.value);
    $('reset-site-icon').disabled = !field.value;
  };
  function load(config) {
    generation++;
    pending = Promise.resolve();
    field.value = config?.siteIcon || '';
    $('site-icon-status').textContent = field.value
      ? '已选择自定义图标。'
      : '正在使用 CloudInk 默认图标。';
    show();
  }
  $('upload-site-icon').addEventListener('click', () => input.click());
  $('reset-site-icon').addEventListener('click', () => {
    generation++;
    field.value = '';
    $('site-icon-status').textContent = '已选择默认图标，保存后生效。';
    show();
  });
  input.addEventListener('change', () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const version = ++generation;
    $('upload-site-icon').disabled = true;
    $('reset-site-icon').disabled = true;
    $('site-icon-status').textContent = '正在校验并上传图标…';
    $('site-icon-status').dataset.tone = 'pending';
    const task = (async () => {
      if (!/\.(svg|ico)$/i.test(file.name)) throw new Error('请选择 SVG 或 ICO 文件。');
      if (!file.size || file.size > 256 * 1024) throw new Error('网站图标需为 1 字节至 256 KB。');
      const prepared = await compressLargeIco(file);
      const result = await api('/api/site-icon', {
        method: 'POST',
        body: prepared.body,
        rawBody: true,
      });
      if (version !== generation) return;
      field.value = result.key;
      $('site-icon-status').textContent = prepared.compressed
        ? `图标已自动压缩并上传（${kb(prepared.fromBytes)} → ${kb(prepared.toBytes)}），保存后应用到后台；发布后更新公开网站。`
        : '图标已上传，保存后应用到后台；发布后更新公开网站。';
      $('site-icon-status').dataset.tone = 'success';
      show();
    })();
    pending = task
      .catch((error) => {
        if (version !== generation) return;
        $('site-icon-status').textContent = error.message;
        $('site-icon-status').dataset.tone = 'error';
        notice(error.message, 'error');
      })
      .finally(() => {
        $('upload-site-icon').disabled = false;
        $('reset-site-icon').disabled = !field.value;
      });
  });
  preview.addEventListener('error', () => {
    if (preview.getAttribute('src') !== '/favicon.svg') {
      preview.src = '/favicon.svg';
      $('site-icon-status').textContent = '自定义图标暂时无法读取，请重新上传或恢复默认。';
      $('site-icon-status').dataset.tone = 'error';
    }
  });
  load(null);
  return { load, ready: () => pending };
}
