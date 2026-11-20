import { $ } from './dom.js';

const SITE_ICON_KEY_RE = /^uploads\/icons\/([a-f0-9]{64})\.(svg|ico|png|jpe?g|webp|gif|avif)$/;
const RASTER_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif']);

function parseIconKey(key) {
  const match = typeof key === 'string' ? key.match(SITE_ICON_KEY_RE) : null;
  return match ? { hash: match[1], ext: match[2] } : null;
}

function previewIconURL(key) {
  const parsed = parseIconKey(key);
  if (!parsed) return '/favicon.svg';
  if (RASTER_EXTS.has(parsed.ext)) return '/site-icon/' + parsed.hash + '-192.png';
  return '/site-icon/' + parsed.hash + '.' + parsed.ext;
}

function originalIconURL(key) {
  const parsed = parseIconKey(key);
  return parsed ? '/site-icon/' + parsed.hash + '.' + parsed.ext : '/favicon.svg';
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes >= 10240 ? Math.round(bytes / 1024) : (bytes / 1024).toFixed(1)) + ' KB';
}

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

async function sniffKind(blob) {
  const head = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
  if (!head.length) return null;
  if (head.length >= 4 && head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0)
    return 'ico';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  )
    return 'png';
  if (
    head.length >= 6 &&
    head[0] === 0x47 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x38 &&
    (head[4] === 0x37 || head[4] === 0x39) &&
    head[5] === 0x61
  )
    return 'gif';
  if (
    head.length >= 12 &&
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  )
    return 'webp';
  if (
    head.length >= 12 &&
    head[4] === 0x66 &&
    head[5] === 0x74 &&
    head[6] === 0x79 &&
    head[7] === 0x70
  ) {
    const brand = String.fromCharCode(...head.subarray(8, 12));
    if (['avif', 'avis', 'mif1'].includes(brand)) return 'avif';
  }
  const text = new TextDecoder().decode(head).trimStart();
  if (/^(?:<\?xml|<!|<svg\b)/i.test(text) && /<svg[\s>]/i.test(text)) return 'svg';
  return null;
}

async function prepareDecodeBlob(blob, kind) {
  if (kind !== 'svg') return blob;
  const text = await blob.text();
  // Ensure viewBox-only SVGs have explicit pixel dimensions so rasterization renders at full 512px.
  const normalized = text.replace(/<svg\b([^>]*)>/i, (full, attrs) => {
    const hasWidth = /\bwidth\s*=/i.test(attrs);
    const hasHeight = /\bheight\s*=/i.test(attrs);
    if (hasWidth && hasHeight) return full;
    return `<svg${attrs}${hasWidth ? '' : ' width="512"'}${hasHeight ? '' : ' height="512"'}>`;
  });
  return new Blob([normalized], { type: 'image/svg+xml' });
}

async function decodeImage(blob, kind) {
  const source = await prepareDecodeBlob(blob, kind);
  const objectUrl = URL.createObjectURL(source);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('浏览器无法解码这张图片，请确认文件完整有效。'));
      img.src = objectUrl;
    });
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) throw new Error('图片尺寸无效，无法生成网站图标。');
    return { img, width, height };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function renderSquarePng(decoded, size, { background = '', insetRatio = 0 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持画布渲染，无法生成派生图标。');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, size, size);
  }
  const side = Math.min(decoded.width, decoded.height);
  const sx = (decoded.width - side) / 2;
  const sy = (decoded.height - side) / 2;
  const inset = Math.round(size * insetRatio);
  const drawSize = size - inset * 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(decoded.img, sx, sy, side, side, inset, inset, drawSize, drawSize);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob || !blob.size) throw new Error(`生成 ${size}×${size} PNG 派生图标失败。`);
  return blob;
}

export async function generateDerivedIcons(blob, kind) {
  const decoded = await decodeImage(blob, kind);
  const [png180, png192, png512, png512Maskable] = await Promise.all([
    renderSquarePng(decoded, 180, { background: '#ffffff' }),
    renderSquarePng(decoded, 192),
    renderSquarePng(decoded, 512),
    renderSquarePng(decoded, 512, { background: '#ffffff', insetRatio: 0.1 }),
  ]);
  let faviconIco = null;
  if (kind !== 'ico') {
    const frames = [];
    for (const size of [16, 32, 48]) {
      const pngBlob = await renderSquarePng(decoded, size);
      frames.push({ size, png: new Uint8Array(await pngBlob.arrayBuffer()) });
    }
    const packed = packPngIco(frames);
    if (!packed.byteLength) throw new Error('生成 favicon.ico 派生图标失败。');
    faviconIco = new Blob([packed], { type: 'image/x-icon' });
  }
  return {
    png180,
    png192,
    png512,
    png512Maskable,
    faviconIco,
    nonSquare: decoded.width !== decoded.height,
  };
}

function appendDerived(form, derived) {
  form.append('derived_180', derived.png180, 'icon-180.png');
  form.append('derived_192', derived.png192, 'icon-192.png');
  form.append('derived_512', derived.png512, 'icon-512.png');
  form.append('derived_512_maskable', derived.png512Maskable, 'icon-512-maskable.png');
  if (derived.faviconIco) form.append('derived_ico', derived.faviconIco, 'favicon.ico');
}

export function configureSiteIcon({ api, notice }) {
  const input = $('site-icon-file'),
    field = $('site-icon-value'),
    sizeField = $('site-icon-size'),
    preview = $('site-icon-preview');
  let generation = 0,
    pending = Promise.resolve();
  const show = () => {
    preview.dataset.fallbackTried = '';
    preview.src = previewIconURL(field.value);
    $('reset-site-icon').disabled = !field.value;
  };
  async function backfillExisting(key, version) {
    const parsed = parseIconKey(key);
    if (!parsed) return;
    $('site-icon-status').textContent = '正在为已有网站图标自动补齐多尺寸派生图…';
    $('site-icon-status').dataset.tone = 'pending';
    const response = await fetch(originalIconURL(key), { credentials: 'same-origin' });
    if (!response.ok) throw new Error('无法读取已有网站图标以补齐派生图。');
    const blob = await response.blob();
    const kind = (await sniffKind(blob)) || parsed.ext;
    const derived = await generateDerivedIcons(blob, kind);
    const form = new FormData();
    form.append('key', key);
    appendDerived(form, derived);
    await api('/api/site-icon/derivatives', { method: 'POST', body: form });
    if (version !== generation) return;
    $('site-icon-status').textContent =
      '已自动为已有图标补齐主屏图标、PWA 清单与分享兜底图，发布后全站统一生效。';
    $('site-icon-status').dataset.tone = 'success';
    show();
  }
  function load(config, { derivativesReady = true } = {}) {
    const version = ++generation;
    pending = Promise.resolve();
    field.value = config?.siteIcon || '';
    if (sizeField) sizeField.value = config?.siteIconSize ? String(config.siteIconSize) : '';
    $('site-icon-status').textContent = field.value
      ? '已选择自定义图标。'
      : '正在使用 CloudInk 默认图标。';
    delete $('site-icon-status').dataset.tone;
    show();
    if (field.value && derivativesReady === false) {
      pending = backfillExisting(field.value, version).catch((error) => {
        if (version !== generation) return;
        $('site-icon-status').textContent =
          '自动补齐派生图未完成（' + error.message + '），可重新上传图标。';
        $('site-icon-status').dataset.tone = 'error';
      });
    }
  }
  $('upload-site-icon').addEventListener('click', () => input.click());
  $('reset-site-icon').addEventListener('click', () => {
    generation++;
    pending = Promise.resolve();
    field.value = '';
    if (sizeField) sizeField.value = '';
    $('site-icon-status').textContent = '已选择默认图标，保存后生效。';
    delete $('site-icon-status').dataset.tone;
    show();
  });
  input.addEventListener('change', () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const version = ++generation;
    $('upload-site-icon').disabled = true;
    $('reset-site-icon').disabled = true;
    $('site-icon-status').textContent = '正在校验图片并生成全套派生图标…';
    $('site-icon-status').dataset.tone = 'pending';
    const task = (async () => {
      if (!file.size) throw new Error('请选择非空的图片文件。');
      const kind = await sniffKind(file);
      if (!kind)
        throw new Error(
          '不支持的文件格式，请上传有效的 PNG、JPG、WebP、GIF、AVIF、SVG 或 ICO 图片。',
        );
      const derived = await generateDerivedIcons(file, kind);
      const form = new FormData();
      form.append('file', file, file.name || `icon.${kind}`);
      appendDerived(form, derived);
      const result = await api('/api/site-icon', {
        method: 'POST',
        body: form,
      });
      if (version !== generation) return;
      field.value = result.key;
      if (sizeField) sizeField.value = result.size ? String(result.size) : String(file.size);
      const cropHint = derived.nonSquare ? '非正方形原图已自动居中裁切生成各尺寸派生图；' : '';
      $('site-icon-status').textContent =
        `图标及全套派生图已上传（原图 ${formatSize(result.size || file.size)}）。${cropHint}保存后应用到后台；发布后更新公开网站。`;
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
    const original = originalIconURL(field.value);
    if (field.value && !preview.dataset.fallbackTried && preview.getAttribute('src') !== original) {
      preview.dataset.fallbackTried = '1';
      preview.src = original;
      return;
    }
    if (preview.getAttribute('src') !== '/favicon.svg') {
      preview.src = '/favicon.svg';
      $('site-icon-status').textContent = '自定义图标暂时无法读取，请重新上传或恢复默认。';
      $('site-icon-status').dataset.tone = 'error';
    }
  });
  load(null);
  return { load, ready: () => pending };
}
