import type { CloudInkEnv } from './env';
import { ensureHomeIllustration } from './home-illustration';
import { ensureManagedImages } from './image-library';
import {
  HttpError,
  jsonInput,
  siteIconDerivedKeys,
  siteIconMime,
  validSiteIconKey,
  validateSite,
} from './models';
import { currentRelease } from './publishing';
import { ensureSiteIcon } from './site-icons';

export type InspectedSiteIcon = {
  bytes: Uint8Array;
  key: string;
  hash: string;
  ext: string;
  type: string;
};

export function createSettingsHooks(env: CloudInkEnv) {
  return {
    jsonInput,
    validateSite,
    async currentSite(storage: R2Bucket) {
      return (await currentRelease({ ...env, STORAGE: storage })).site;
    },
    ensureManagedImages,
    ensureHomeIllustration,
    ensureSiteIcon,
    siteIconDerivedKeys,
    validSiteIconKey,
    siteIconMime,
    error: (status: number, message: string) => new HttpError(status, message),
  };
}

export type SettingsHooks = ReturnType<typeof createSettingsHooks>;
