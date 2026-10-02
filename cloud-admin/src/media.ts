import { HttpError } from './models';

export const MAX_IMAGE = 10 * 1024 * 1024;
// The single bucket also contains credentials and drafts. Media routes must
// never translate an arbitrary URL into an arbitrary object key.
export function validImageKey(key: string): boolean {
  return (
    key.length <= 1024 &&
    /^uploads\/[A-Za-z0-9_./-]+\.(?:jpg|jpeg|png|webp|gif|avif)$/.test(key) &&
    !key.split('/').some((part) => !part || part === '.' || part === '..')
  );
}
export function imageType(bytes: Uint8Array): { type: string; ext: string } {
  const text = new TextDecoder().decode(bytes.slice(0, 16));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { type: 'image/jpeg', ext: 'jpg' };
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n))
    return { type: 'image/png', ext: 'png' };
  if (text.startsWith('GIF87a') || text.startsWith('GIF89a'))
    return { type: 'image/gif', ext: 'gif' };
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP')
    return { type: 'image/webp', ext: 'webp' };
  if (text.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(text.slice(8, 12)))
    return { type: 'image/avif', ext: 'avif' };
  throw new HttpError(400, '请上传 JPEG、PNG、GIF、WebP 或 AVIF 图片。');
}
