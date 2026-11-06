import { decodeHTML, decodeHTMLAttribute } from 'entities';
import { micromark } from 'micromark';
import { validImageKey } from './media';

export const IMAGE_REFERENCE_VERSION = '2';

function keyFromUrl(input: string, origin: string, local: boolean): string | null {
  try {
    const url = new URL(decodeHTMLAttribute(input), origin);
    if (local && url.origin !== origin) return null;
    if (!url.pathname.startsWith('/images/')) return null;
    const key = decodeURIComponent(url.pathname.slice('/images/'.length));
    return validImageKey(key) ? key : null;
  } catch {
    return null;
  }
}
// Deletion protection includes literal mentions. Normalize both CommonMark
// escapes and HTML URL backslashes conservatively, retaining either result.
export function managedImageKeys(source: string): string[] {
  const decoded = decodeHTML(source)
    .replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/[\t\r\n]/g, '');
  const keys = new Set<string>();
  for (const text of [decoded.replace(/\\([^\w\s])/g, '$1'), decoded.replace(/\\/g, '/')]) {
    for (const match of text.matchAll(
      /uploads\/[A-Za-z0-9_./-]{1,1016}\.(?:jpeg|jpg|png|webp|gif|avif|svg|ico)\b/g,
    )) {
      const key = keyFromUrl('/images/' + match[0], 'https://cloudink.invalid', false);
      if (key) keys.add(key);
    }
  }
  return [...keys];
}
export async function localImageKeys(source: string, origin: string): Promise<string[]> {
  if (!managedImageKeys(source).length) return [];
  const body = source
    .replace(/^\uFEFF/, '')
    .replace(/^\+\+\+\r?\n[\s\S]*?\r?\n\+\+\+(?:\r?\n|$)/, '');
  const html = micromark(body, { allowDangerousHtml: true });
  const keys = new Set<string>();
  const add = (value: string) => {
    const key = keyFromUrl(value, origin, true);
    if (key) keys.add(key);
  };
  // Generated HTML is inspected only. It is never served or executed.
  const response = new HTMLRewriter()
    .on('img,source', {
      element(el) {
        const src = el.getAttribute('src');
        if (src) add(src);
        for (const item of (el.getAttribute('srcset') || '').split(',')) {
          const url = item.trim().split(/\s+/)[0];
          if (url) add(url);
        }
      },
    })
    .transform(new Response(html));
  if (response.body) await response.body.pipeTo(new WritableStream({ write() {} }));
  return [...keys];
}
