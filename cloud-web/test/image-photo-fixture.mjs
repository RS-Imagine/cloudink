import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { imageInfo } from '../../cloud-admin/src/image-info.ts';
// NASA / Apollo 17 crew, public domain. Source and licensing:
// https://commons.wikimedia.org/wiki/File:The_Earth_seen_from_Apollo_17.jpg
const url = 'https://upload.wikimedia.org/wikipedia/commons/9/97/The_Earth_seen_from_Apollo_17.jpg';
const directory = 'build-work/image-quality';
let bytes;
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'CloudInk image regression (https://github.com/RS-Imagine/cloudink)' },
      signal: AbortSignal.timeout(30000),
    });
    assert.ok(response.ok, 'Photo fixture HTTP ' + response.status);
    const length = Number(response.headers.get('Content-Length'));
    assert.ok(length > 0 && length <= 10 * 1024 * 1024);
    bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length <= 10 * 1024 * 1024);
    assert.deepEqual(imageInfo(bytes), { width: 3000, height: 3002, animated: false });
    break;
  } catch (error) {
    if (attempt === 2) throw error;
  }
}
await mkdir(directory, { recursive: true });
await writeFile(directory + '/apollo17.jpg', bytes);
const provenance = { url, author: 'NASA / Apollo 17 crew', license: 'Public domain (NASA)', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
await writeFile(directory + '/source.json', JSON.stringify(provenance, null, 2));
console.log('IMAGE_PHOTO_SOURCE ' + JSON.stringify(provenance));
