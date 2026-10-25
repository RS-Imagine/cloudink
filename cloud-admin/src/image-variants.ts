import { HttpError, json, limitedBody } from './models';
import { MAX_IMAGE, imageType, validImageKey } from './media';
import { imageInfo } from './image-info';

export const IMAGE_WIDTHS = [640, 1280, 1920];
export function parentImageKey(key: string): string {
  const match = key.match(/^(.*)\.w(640|1280|1920)\.webp$/);
  return match && validImageKey(match[1]) ? match[1] : key;
}
export function imageDimensions(bytes: Uint8Array): Record<string, string> {
  const info = imageInfo(bytes);
  return info.width && info.height
    ? { width: String(info.width), height: String(info.height) }
    : {};
}
export function imagePresentation(object: R2Object, variants: R2Object[]) {
  const width = Number(object.customMetadata?.width),
    height = Number(object.customMetadata?.height);
  const choices = variants
    .filter(
      (item) =>
        IMAGE_WIDTHS.some((size) => item.key === object.key + '.w' + size + '.webp') &&
        item.httpMetadata?.contentType === 'image/webp' &&
        Number(item.customMetadata?.width) > 0,
    )
    .sort((a, b) => Number(a.customMetadata?.width) - Number(b.customMetadata?.width));
  const normal = choices.find((item) => Number(item.customMetadata?.width) >= 1280);
  const candidates = choices.map(
    (item) => '/images/' + item.key + ' ' + item.customMetadata?.width + 'w',
  );
  if (choices.length && width > Number(choices.at(-1)?.customMetadata?.width))
    candidates.push('/images/' + object.key + ' ' + width + 'w');
  return {
    ...(width > 0 && height > 0 ? { width, height } : {}),
    displayUrl: '/images/' + (normal?.key || object.key),
    thumbnailKey: choices[0]?.key || object.key,
    fullUrl: '/images/' + object.key,
    srcset: candidates.join(', '),
    displaySize: normal?.size || object.size,
    totalSize: object.size + choices.reduce((sum, item) => sum + item.size, 0),
  };
}
async function prepareVariants(
  form: FormData,
  info: ReturnType<typeof imageInfo>,
  sourceSize: number,
  key: string,
) {
  const prepared: { key: string; bytes: Uint8Array; metadata: Record<string, string> }[] = [];
  for (const width of IMAGE_WIDTHS) {
    const part = form.get('w' + width);
    if (!part) continue;
    if (typeof part === 'string' || part.size > 2_000_000 || part.size >= sourceSize)
      throw new HttpError(400, '压缩图片大小不正确。');
    const data = new Uint8Array(await part.arrayBuffer()),
      variant = imageInfo(data);
    if (
      imageType(data).type !== 'image/webp' ||
      variant.animated ||
      variant.width !== width ||
      !info.width ||
      !info.height ||
      info.animated ||
      width > info.width ||
      !variant.height ||
      Math.abs(variant.height - (info.height * width) / info.width) > 1
    )
      throw new HttpError(400, '压缩图片的格式或尺寸不正确。');
    prepared.push({
      key: key + '.w' + width + '.webp',
      bytes: data,
      metadata: imageDimensions(data),
    });
  }
  return prepared;
}

export async function uploadImage(request: Request, storage: R2Bucket): Promise<Response> {
  const body = await limitedBody(request, MAX_IMAGE + 6_000_000 + 64 * 1024);
  const form = await new Response(body, {
    headers: { 'Content-Type': request.headers.get('Content-Type') || '' },
  }).formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new HttpError(400, '请选择图片。');
  if (file.size > MAX_IMAGE) throw new HttpError(413, '每张图片最多 10 MB。');
  const bytes = new Uint8Array(await file.arrayBuffer()),
    type = imageType(bytes),
    info = imageInfo(bytes);
  const basename =
    file.name
      .replace(/\.[^.]*$/, '')
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .slice(0, 50) || 'image';
  const key =
    'uploads/' +
    new Date().toISOString().slice(0, 7).replace('-', '/') +
    '/' +
    crypto.randomUUID() +
    '-' +
    basename +
    '.' +
    type.ext;
  const prepared = await prepareVariants(form, info, file.size, key);
  const written: string[] = [],
    variants: R2Object[] = [];
  try {
    // Save derivatives first. On failure the family is removed; no half-built library entry.
    for (const part of prepared) {
      written.push(part.key);
      const object = await storage.put(part.key, part.bytes, {
        customMetadata: part.metadata,
        httpMetadata: {
          contentType: 'image/webp',
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });
      if (!object) throw new Error('Image write failed');
      variants.push(object);
    }
    written.push(key);
    const object = await storage.put(key, bytes, {
      customMetadata: { name: file.name.slice(0, 160), ...imageDimensions(bytes) },
      httpMetadata: { contentType: type.type, cacheControl: 'public, max-age=31536000, immutable' },
    });
    if (!object) throw new Error('Image write failed');
    return json(
      { key, url: '/images/' + key, name: file.name, ...imagePresentation(object, variants) },
      201,
    );
  } catch (error) {
    await storage.delete(written);
    throw error;
  }
}

/** Enrich once at publication time. Reader requests perform no extra image metadata reads. */
export async function responsiveImages(
  html: string,
  storage: R2Bucket,
  origin: string,
): Promise<string> {
  const families = new Map<string, Promise<ReturnType<typeof imagePresentation> | null>>();
  return new HTMLRewriter()
    .on('.article-body img', {
      async element(el) {
        if (el.hasAttribute('srcset')) return; // Respect explicitly authored responsive HTML.
        let key: string;
        try {
          const url = new URL(el.getAttribute('src') || '', origin);
          if (url.origin !== origin || !url.pathname.startsWith('/images/')) return;
          key = parentImageKey(decodeURIComponent(url.pathname.slice(8)));
          if (!validImageKey(key)) return;
        } catch {
          return;
        }
        if (!families.has(key)) {
          if (families.size >= 100) return; // Bound publication subrequests for unusually large pages.
          families.set(
            key,
            (async () => {
              const [object, ...variants] = await Promise.all(
                [key, ...IMAGE_WIDTHS.map((width) => key + '.w' + width + '.webp')].map((path) =>
                  storage.head(path),
                ),
              );
              return object
                ? imagePresentation(
                    object,
                    variants.filter((item): item is R2Object => !!item),
                  )
                : null;
            })(),
          );
        }
        const info = await families.get(key);
        if (!info) return;
        if (!el.hasAttribute('width') && !el.hasAttribute('height') && info.width && info.height) {
          el.setAttribute('width', String(info.width));
          el.setAttribute('height', String(info.height));
        }
        if (info.srcset) {
          el.setAttribute('src', info.displayUrl);
          el.setAttribute('srcset', info.srcset);
          el.setAttribute('sizes', '(max-width: 759px) calc(100vw - 44px), 720px');
          el.setAttribute('data-full-src', info.fullUrl);
        }
      },
    })
    .transform(new Response(html))
    .text();
}

/** Optimize an existing immutable original under the content-mutation lease. */
export async function optimizeImage(request: Request, storage: R2Bucket): Promise<Response> {
  const body = await limitedBody(request, 6_000_000 + 64 * 1024);
  const form = await new Response(body, {
    headers: { 'Content-Type': request.headers.get('Content-Type') || '' },
  }).formData();
  const key = form.get('key'),
    etag = form.get('etag');
  if (
    typeof key !== 'string' ||
    !validImageKey(key) ||
    parentImageKey(key) !== key ||
    !/\.(?:png|jpe?g|webp)$/.test(key)
  )
    throw new HttpError(400, '请选择可优化的 JPEG、PNG 或 WebP 原图。');
  const original = await storage.get(key);
  if (!original) throw new HttpError(404, '原图已不存在，请刷新图片库。');
  if (etag !== original.etag) {
    await original.body.cancel();
    throw new HttpError(409, '原图已变化，请刷新后重新优化。');
  }
  if (original.size > MAX_IMAGE) {
    await original.body.cancel();
    throw new HttpError(413, '这张原图超过 10 MB，请先在外部处理。');
  }
  const bytes = new Uint8Array(await original.arrayBuffer()),
    info = imageInfo(bytes);
  const prepared = await prepareVariants(form, info, original.size, key);
  // Mark the original before writing derivatives so an interrupted request is resumable.
  const marked = await storage.put(key, bytes, {
    onlyIf: { etagMatches: original.etag },
    httpMetadata: original.httpMetadata,
    customMetadata: {
      ...original.customMetadata,
      ...imageDimensions(bytes),
      optimization: 'processing',
    },
  });
  if (!marked) throw new HttpError(409, '原图已变化，请刷新后重新优化。');
  const created: string[] = [];
  try {
    for (const part of prepared) {
      const saved = await storage.put(part.key, part.bytes, {
        onlyIf: { etagDoesNotMatch: '*' },
        customMetadata: part.metadata,
        httpMetadata: {
          contentType: 'image/webp',
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });
      if (saved) created.push(part.key);
    }
    const variants = (
      await Promise.all(IMAGE_WIDTHS.map((width) => storage.head(key + '.w' + width + '.webp')))
    ).filter((item): item is R2Object => !!item);
    const updated = await storage.put(key, bytes, {
      onlyIf: { etagMatches: original.etag },
      httpMetadata: original.httpMetadata,
      customMetadata: {
        ...original.customMetadata,
        ...imageDimensions(bytes),
        optimization: variants.length ? 'complete' : 'skipped',
      },
    });
    if (!updated) throw new HttpError(409, '原图已变化，请刷新后重新优化。');
    return json({
      key,
      optimized: !!variants.length,
      addedBytes: variants
        .filter((item) => created.includes(item.key))
        .reduce((sum, item) => sum + item.size, 0),
    });
  } catch (error) {
    if (created.length) await storage.delete(created);
    throw error;
  }
}
