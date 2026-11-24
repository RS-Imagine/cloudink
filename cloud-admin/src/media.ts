import { validSiteIconKey } from './models';

// The single bucket also contains credentials and drafts. Media routes must
// never translate an arbitrary URL into an arbitrary object key.
export function validImageKey(key: string): boolean {
  return (
    validSiteIconKey(key) ||
    (key.length <= 1024 &&
      /^uploads\/[A-Za-z0-9_./-]+\.(?:jpg|jpeg|png|webp|gif|avif)$/.test(key) &&
      !key.split('/').some((part) => !part || part === '.' || part === '..'))
  );
}
// Older published snapshots used the authenticated editor URL. Rewrite only
// same-origin URLs for objects that the public media route already allows.
export function legacyImagePath(input: string, origin: string): string | null {
  try {
    const url = new URL(input, origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.pathname !== '/api/image' ||
      url.searchParams.getAll('key').length !== 1
    )
      return null;
    const key = url.searchParams.get('key')!;
    return validImageKey(key) ? '/images/' + key : null;
  } catch {
    return null;
  }
}
