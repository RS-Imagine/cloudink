import { HttpError, siteIconMime, type SiteConfig } from './models';

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
