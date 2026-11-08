import { digest } from './auth';
import { imageReferenceMetadata } from './image-reference-index';
import { sourceDigest } from './save-digest';
import type { Draft, ShortDraft } from './models';

export async function shortSummary(
  draft: ShortDraft,
  source: string,
  storage: R2Bucket,
  previous?: Record<string, string>,
): Promise<Record<string, string>> {
  return {
    source_digest: await sourceDigest(source),
    date: draft.front_matter.date,
    snippet: draft.body_markdown.slice(0, 300).replace(/\r?\n/g, ' '),
    ...(await imageReferenceMetadata(source, storage, previous?.image_refs_hash)),
  };
}

export function editorial(draft: Draft): string {
  const f = draft.front_matter;
  return JSON.stringify([
    f.title,
    f.slug,
    f.date,
    f.description,
    draft.body_markdown,
    ...(f.aliases?.length ? [f.aliases] : []),
  ]);
}
export async function draftSummary(
  draft: Draft,
  storage: R2Bucket,
  previous?: Record<string, string>,
): Promise<Record<string, string>> {
  const f = draft.front_matter;
  return {
    title: f.title.slice(0, 120),
    date: f.date,
    description: f.description.slice(0, 240),
    ...(await imageReferenceMetadata(draft.body_markdown, storage, previous?.image_refs_hash)),
    digest: await digest(editorial(draft)),
  };
}
