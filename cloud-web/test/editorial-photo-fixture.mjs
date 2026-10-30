// CC0 landscape for isolated visual review; never published as site content.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { imageInfo } from '../../cloud-admin/src/image-info.ts';

const url = 'https://upload.wikimedia.org/wikipedia/commons/8/8b/Autumn_Lake_Landscape.jpg';
const directory = 'build-work/editorial-photo';
let bytes;
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'CloudInk visual review (https://github.com/RS-Imagine/cloudink)',
      },
      signal: AbortSignal.timeout(30000),
    });
    assert.ok(response.ok, 'Landscape fixture HTTP ' + response.status);
    const length = Number(response.headers.get('Content-Length'));
    assert.ok(length > 0 && length <= 12 * 1024 * 1024);
    bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length <= 12 * 1024 * 1024);
    assert.deepEqual(imageInfo(bytes), { width: 5799, height: 3866, animated: false });
    break;
  } catch (error) {
    if (attempt === 2) throw error;
  }
}
assert.equal(
  createHash('sha256').update(bytes).digest('hex'),
  '7f1c23529631cdbafe2af21134ab5340c0c8a251c9ba2e456b2fad6b06855f70',
  'The CC0 landscape changed; review provenance before updating its digest.',
);
await mkdir(directory, { recursive: true });
await writeFile(directory + '/lake.jpg', bytes);
const provenance = {
  url,
  source: 'https://commons.wikimedia.org/wiki/File:Autumn_Lake_Landscape.jpg',
  author: "Holly's Coastal View",
  license: 'CC0-1.0',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
};
await writeFile(directory + '/source.json', JSON.stringify(provenance, null, 2));
console.log('EDITORIAL_PHOTO_SOURCE ' + JSON.stringify(provenance));
