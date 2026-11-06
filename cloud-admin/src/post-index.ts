import { managedImageKeys, IMAGE_REFERENCE_VERSION } from './image-references';
import { validImageKey } from './media';
import { digest } from './auth';
import { editorial } from './post-metadata';
import {
  HttpError,
  parseSource,
  parseShortSource,
  readJson,
  type FrontMatter,
  type Release,
  type SiteConfig,
} from './models';
export interface PublishedSummary extends FrontMatter {
  digest: string;
}
export interface ReleaseImageEntry {
  scope: string;
  slug?: string;
  title: string;
  settings?: boolean;
  keys: string[];
}
export interface PostIndex {
  schema_version: 1;
  id: string;
  site: SiteConfig;
  posts: Record<string, PublishedSummary>;
  shorts?: Record<string, { date: string; snippet: string }>;
  images?: { version: string; entries: ReleaseImageEntry[] };
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
      prior && prior.id === base?.id && Object.hasOwn(prior.posts, slug)
        ? prior.posts[slug]
        : undefined;
    if (old && base?.markdown_posts[slug] === source) {
      posts[slug] = old;
      continue;
    }
    const draft = parseSource(source);
    if (draft.front_matter.slug !== slug) throw new HttpError(400, '文章地址与原稿不一致。');
    if (!draft.front_matter.draft)
      posts[slug] = { ...draft.front_matter, digest: await digest(editorial(draft)) };
  }
  const shorts: NonNullable<PostIndex['shorts']> = Object.create(null);
  for (const [slug, source] of Object.entries(release.markdown_shorts || {})) {
    if (
      prior &&
      prior.id === base?.id &&
      base?.markdown_shorts?.[slug] === source &&
      Object.hasOwn(prior.shorts || {}, slug)
    ) {
      shorts[slug] = prior.shorts![slug];
      continue;
    }
    const draft = parseShortSource(source);
    if (draft.front_matter.slug !== slug) throw new HttpError(400, '短记地址与原稿不一致。');
    if (!draft.front_matter.draft)
      shorts[slug] = { date: draft.front_matter.date, snippet: draft.body_markdown.slice(0, 300) };
  }
  const entries: ReleaseImageEntry[] = [];
  const oldImages =
    prior &&
    prior.id === base?.id &&
    prior.images?.version === IMAGE_REFERENCE_VERSION
      ? new Map(prior.images.entries.map((e) => [e.scope, e]))
      : new Map<string, ReleaseImageEntry>();
  const addImages = (
    scope: string,
    source: string,
    previous: string | undefined,
    title: string,
    slug?: string,
  ) => {
    const old = oldImages.get(scope);
    entries.push(
      old && source === previous
        ? old
        : {
            scope,
            title,
            ...(slug ? { slug } : { settings: true }),
            keys: managedImageKeys(source),
          },
    );
  };
  for (const [slug, source] of Object.entries(release.markdown_posts))
    addImages('post:' + slug, source, base?.markdown_posts[slug], slug, slug);
  for (const [slug, source] of Object.entries(release.markdown_shorts || {}))
    addImages('short:' + slug, source, base?.markdown_shorts?.[slug], slug, slug);
  addImages(
    'site',
    JSON.stringify(release.site),
    base ? JSON.stringify(base.site) : undefined,
    '网站设置',
  );
  addImages('about', release.about_markdown || '', base?.about_markdown, '关于页面');
  return {
    schema_version: 1,
    id: release.id,
    site: release.site,
    posts,
    shorts,
    images: { version: IMAGE_REFERENCE_VERSION, entries },
  };
}
export async function readPostIndex(storage: R2Bucket, id: string): Promise<PostIndex | null> {
  const index = await readJson<PostIndex>(storage, postIndexKey(id));
  if (!index) return null;
  if (
    index.schema_version !== 1 ||
    index.id !== id ||
    !index.site ||
    !index.posts ||
    (index.shorts !== undefined &&
      (!index.shorts ||
        typeof index.shorts !== 'object' ||
        Array.isArray(index.shorts) ||
        Object.values(index.shorts).some(
          (s) => !s || typeof s.date !== 'string' || typeof s.snippet !== 'string',
        ))) ||
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
  if (
    index.images !== undefined &&
    (!index.images ||
      typeof index.images.version !== 'string' ||
      !Array.isArray(index.images.entries) ||
      index.images.entries.some(
        (e) =>
          !e ||
          typeof e.scope !== 'string' ||
          typeof e.title !== 'string' ||
          (e.slug !== undefined && typeof e.slug !== 'string') ||
          (e.settings !== undefined && typeof e.settings !== 'boolean') ||
          !Array.isArray(e.keys) ||
          e.keys.some((k) => typeof k !== 'string' || !validImageKey(k)),
      ))
  )
    throw new HttpError(503, '发布图片引用摘要无效；图片仍受保护，请重新发布。');
  return index;
}
