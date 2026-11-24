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
export async function contentImageKey(bytes: Uint8Array, ext: string): Promise<string> {
  return 'uploads/sha256/' + (await sha256Hex(bytes)) + '.' + ext;
}
