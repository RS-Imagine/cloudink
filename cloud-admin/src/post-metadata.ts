import { digest } from './auth';
import { imageReferenceMetadata } from './image-library';
import type { Draft } from './models';

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
export async function draftSummary(draft: Draft): Promise<Record<string, string>> {
  const f = draft.front_matter;
  return {
    title: f.title.slice(0, 120),
    date: f.date,
    description: f.description.slice(0, 240),
    ...imageReferenceMetadata(draft.body_markdown),
    digest: await digest(editorial(draft)),
  };
}
