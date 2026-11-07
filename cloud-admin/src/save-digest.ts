import { digest } from './auth';
import { IMAGE_REFERENCE_VERSION } from './image-references';

// Version the full persisted source digest separately from the editorial digest.
export const sourceDigest = (source: string) => digest('source-v1:' + source);
export async function unchangedSource(object: R2Object, source: string): Promise<boolean> {
  // Old metadata is repaired by one normal save, including missing short snippets.
  if (
    object.customMetadata?.image_refs_version !== IMAGE_REFERENCE_VERSION ||
    object.customMetadata.source_digest !== (await sourceDigest(source))
  )
    return false;
  // Only metadata written by this server reaches this fast path.
  return true;
}
