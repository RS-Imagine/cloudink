import { HttpError, validHomeIllustration, type SiteConfig } from './models';

export async function ensureHomeIllustration(storage: R2Bucket, site: SiteConfig): Promise<void> {
  const key = site.homeIllustration;
  if (!key || key === 'default') return;
  if (!validHomeIllustration(key)) throw new HttpError(400, '首页插画地址无效。');
  const object = await storage.head(key);
  if (
    !object ||
    !/^image\/(?:jpeg|png|webp|gif|avif|svg\+xml)$/.test(object.httpMetadata?.contentType || '')
  )
    throw new HttpError(400, '首页插画已被删除或尚未上传，请重新选择后保存。');
}
