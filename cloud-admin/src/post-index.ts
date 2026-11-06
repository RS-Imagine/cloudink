import { digest } from './auth';
import { editorial } from './post-metadata';
import {
  HttpError,
  parseSource,
  readJson,
  type FrontMatter,
  type Release,
  type SiteConfig,
} from './models';
export interface PublishedSummary extends FrontMatter {
  digest: string;
}
export interface PostIndex {
  schema_version: 1;
  id: string;
  site: SiteConfig;
  posts: Record<string, PublishedSummary>;
}
export const postIndexKey = (id: string) => 'releases/' + id + '.posts.json';
export async function buildPostIndex(
  release: Release,
  base?: Release,
  prior?: PostIndex | null,
): Promise<PostIndex> {
  const posts: Record<string, PublishedSummary> = Object.create(null);
  for (const [slug, source] of Object.entries(release.markdown_posts)) {
    const old =
      prior?.id === base?.id && Object.hasOwn(prior.posts, slug) ? prior.posts[slug] : undefined;
    if (old && base?.markdown_posts[slug] === source) {
      posts[slug] = old;
      continue;
    }
    const draft = parseSource(source);
    if (draft.front_matter.slug !== slug) throw new HttpError(400, '文章地址与原稿不一致。');
    if (!draft.front_matter.draft)
      posts[slug] = { ...draft.front_matter, digest: await digest(editorial(draft)) };
  }
  return { schema_version: 1, id: release.id, site: release.site, posts };
}
export async function readPostIndex(storage: R2Bucket, id: string): Promise<PostIndex | null> {
  const index = await readJson<PostIndex>(storage, postIndexKey(id));
  if (!index) return null;
  if (
    index.schema_version !== 1 ||
    index.id !== id ||
    !index.site ||
    !index.posts ||
    Object.values(index.posts).some(
      (p) =>
        !p ||
        typeof p.title !== 'string' ||
        typeof p.date !== 'string' ||
        typeof p.description !== 'string' ||
        typeof p.digest !== 'string',
    )
  )
    throw new HttpError(503, '文章摘要索引无效，请重新发布网站。');
  return index;
}
