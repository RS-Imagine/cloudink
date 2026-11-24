import { activeBackup } from './backup-jobs';
import {
  checkedReferenceKeys,
  imageReferenceMetadata,
  readReferenceShard,
  referenceShardKey,
} from './image-reference-index';
import { IMAGE_REFERENCE_VERSION, managedImageKeys } from './image-references';
import { HttpError, jsonInput, siteIconDerivedKeys } from './models';
import { withContentMutation } from './storage-mutations';

export const imageHooks = {
  withContentMutation,
  jsonInput,
  activeBackup,
  managedImageKeys,
  referenceShardKey,
  readReferenceShard,
  checkedReferenceKeys,
  imageReferenceMetadata,
  referenceVersion: IMAGE_REFERENCE_VERSION,
  siteIconDerivedKeys,
  errorStatus(error: unknown) {
    return error instanceof HttpError ? error.status : null;
  },
  error: (status: number, message: string) => new HttpError(status, message),
};

export type ImageHooks = typeof imageHooks;
