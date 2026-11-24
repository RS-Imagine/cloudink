import type { CloudInkEnv } from './env';
import { HttpError, readJson, type Release } from './models';

export async function currentRelease(
  env: CloudInkEnv,
  snapshot?: { id: string } | null,
): Promise<Release> {
  const pointer =
    snapshot === undefined
      ? await readJson<{ id: string }>(env.STORAGE, 'state/published.json')
      : snapshot;
  if (!pointer) throw new HttpError(503, '网站内容尚未初始化，请完成后台首次设置。');
  const release = await readJson<Release>(env.STORAGE, `releases/${pointer.id}.json`);
  if (!release) throw new HttpError(503, '网站内容版本缺失，请联系维护者。');
  return release;
}
