import type { CloudInkEnv } from './env';
import type { Release, SiteConfig } from './models';

export interface BrowserPointer {
  id: string;
  published_at?: string;
  pages?: Record<string, string>;
  previous_ids?: string[];
  publishing?: string;
  templateVersion?: string;
  responseVersion?: string;
  generationVersion?: string;
  clarityId?: string;
  siteIcon?: string;
  siteIconSize?: number;
  postRedirects?: Record<string, string>;
}

export async function initializeBrowserContent(env: CloudInkEnv, site: SiteConfig): Promise<void> {
  if (await env.STORAGE.head('state/published.json')) return;
  const release: Release = {
    schema_version: 1,
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    site,
    markdown_posts: {},
  };
  if (site?.about) release.about_markdown = aboutSource(site.about);
  await env.STORAGE.put(
    `releases/${release.id}.posts.json`,
    JSON.stringify({ schema_version: 1, id: release.id, site, posts: {} }),
  );
  await env.STORAGE.put(`releases/${release.id}.json`, JSON.stringify(release));
  await env.STORAGE.put(
    'state/published.json',
    JSON.stringify({
      id: release.id,
      clarityId: release.site.clarityId || '',
      siteIcon: release.site.siteIcon || '',
      ...(release.site.siteIconSize ? { siteIconSize: release.site.siteIconSize } : {}),
    }),
    { onlyIf: { etagDoesNotMatch: '*' } },
  );
}
export function aboutSource(markdown: string): string {
  return '+++\ntitle = "About"\ndescription = ""\n+++\n\n' + markdown;
}
