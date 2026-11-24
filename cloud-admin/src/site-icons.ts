import { imageInfo } from './image-info';
import { imageType } from './media';
import { HttpError, siteIconMime, type SiteConfig } from './models';

export function detectRasterIcon(input: Uint8Array): { ext: string; type: string } | null {
  let detected: { ext: string; type: string };
  try {
    detected = imageType(input);
  } catch {
    return null;
  }
  if (detected.ext !== 'avif') {
    const info = imageInfo(input);
    if (!info.width || !info.height || info.width <= 0 || info.height <= 0)
      throw new HttpError(400, '图片文件已损坏或无法读取尺寸，请重新选择图片。');
  }
  return detected;
}

export async function ensureSiteIcon(storage: R2Bucket, site: SiteConfig): Promise<void> {
  if (!site.siteIcon) {
    delete site.siteIconSize;
    return;
  }
  const object = await storage.head(site.siteIcon);
  if (!object || object.httpMetadata?.contentType !== siteIconMime(site.siteIcon))
    throw new HttpError(400, '网站图标已被删除或尚未上传，请重新选择后保存。');
  site.siteIconSize = object.size;
}
