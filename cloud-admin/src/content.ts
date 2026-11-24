import { PAGE_GENERATION_VERSION, PUBLIC_RESPONSE_VERSION } from './assets.generated';
import type { CloudInkEnv } from './env';
import { ensureHomeIllustration } from './home-illustration';
import { ensureManagedImages } from './image-library';
import { imageReferenceMetadata } from './image-reference-index';
import { IMAGE_REFERENCE_VERSION, managedImageKeys } from './image-references';
import {
  HttpError,
  jsonInput,
  parseShortSource,
  parseSource,
  serializeDraft,
  serializeShortDraft,
  validateDraft,
  validateShortDraft,
  validateSite,
} from './models';
import { ensureSiteIcon } from './site-icons';
import { withContentMutation } from './storage-mutations';
import { CURRENT_TEMPLATE_VERSION } from './template-version.generated';

export function createContentHooks(env: CloudInkEnv) {
  return {
    jsonInput,
    imageReferenceMetadata,
    managedImageKeys,
    parseSource,
    parseShortSource,
    serializeDraft,
    serializeShortDraft,
    validateDraft,
    validateShortDraft,
    validateSite,
    ensureManagedImages,
    ensureHomeIllustration,
    ensureSiteIcon,
    referenceVersion: IMAGE_REFERENCE_VERSION,
    templateVersion: CURRENT_TEMPLATE_VERSION,
    generationVersion: PAGE_GENERATION_VERSION,
    responseVersion: PUBLIC_RESPONSE_VERSION,
    setupToken: env.SETUP_TOKEN,
    withContentMutation,
    errorStatus: (error: unknown) => (error instanceof HttpError ? error.status : null),
    error: (status: number, message: string) => new HttpError(status, message),
  };
}

export type ContentHooks = ReturnType<typeof createContentHooks>;
