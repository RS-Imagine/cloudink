import { sha256Hex } from './crypto';
import { validImageKey } from './media';
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
export async function contentImageKey(bytes: Uint8Array, ext: string): Promise<string> {
  return 'uploads/sha256/' + (await sha256Hex(bytes)) + '.' + ext;
}

/** Enrich once at publication time. Reader requests perform no extra image metadata reads. */
export async function responsiveImages(
  html: string,
  storage: R2Bucket,
  origin: string,
): Promise<string> {
  const families = new Map<string, Promise<ReturnType<typeof imagePresentation> | null>>();
  return new HTMLRewriter()
    .on('.article-body img, .home-thumbnail img', {
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
          if (!el.hasAttribute('sizes'))
            el.setAttribute('sizes', '(max-width: 759px) calc(100vw - 44px), 720px');
          el.setAttribute('data-full-src', info.fullUrl);
        }
      },
    })
    .transform(new Response(html))
    .text();
}
