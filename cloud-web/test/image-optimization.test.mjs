import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, draft, origin } from './fixture.mjs';
import { imageInfo } from '../../cloud-admin/src/image-info.ts';

// Header fixtures exercise API validation/storage; real decoding is covered in browsers.
function png(width = 2048, height = 1536) {
  const bytes = new Uint8Array(100000), view = new DataView(bytes.buffer);
  bytes.set([137,80,78,71,13,10,26,10]); view.setUint32(8,13);
  bytes.set([73,72,68,82],12); view.setUint32(16,width); view.setUint32(20,height);
  return bytes;
}
function webp(width = 640, height = 480) {
  const bytes = new Uint8Array(30), view = new DataView(bytes.buffer);
  bytes.set(Buffer.from('RIFF')); view.setUint32(4,22,true); bytes.set(Buffer.from('WEBPVP8X'),8);
  view.setUint32(16,10,true);
  for (const [at,value] of [[24,width-1],[27,height-1]]) {
    bytes[at] = value & 255; bytes[at+1] = (value >>> 8) & 255; bytes[at+2] = value >>> 16;
  }
  return bytes;
}
async function upload(f, variant = webp()) {
  const auth = await f.request('/api/login','POST',{ email: 'reader@example.net', password: 'first-private-password-26' });
  const cookie = auth.headers.get('Set-Cookie').split(';')[0], session = await auth.json();
  const body = new FormData();
  body.append('file', new Blob([png()], {type:'image/png'}), 'photo.png');
  body.append('w640', new Blob([variant], {type:'image/webp'}), '640.webp');
  return f.mf.dispatchFetch(origin + '/api/upload', { method:'POST', headers:{ Origin:origin, Cookie:cookie, 'X-CSRF-Token':session.csrf }, body });
}
test('image headers handle animated PNG/WebP, EXIF rotation and truncated data without decoding', () => {
  assert.deepEqual(imageInfo(png()), { width:2048, height:1536, animated:false });
  assert.deepEqual(imageInfo(webp()), { width:640, height:480, animated:false });
  const animated = webp(); animated[20] = 2;
  assert.equal(imageInfo(animated).animated, true);
  const apng = png(); new DataView(apng.buffer).setUint32(33,8); apng.set(Buffer.from('acTL'),37);
  assert.equal(imageInfo(apng).animated, true);
  const jpeg = new Uint8Array([255,216,255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0,255,192,0,11,8,1,224,2,128,1,1,17,0,255,217]);
  assert.deepEqual(imageInfo(jpeg), { width:480, height:640, animated:false });
  for (const bytes of [png(),webp(),jpeg]) for (let end=0;end<30;end++) assert.doesNotThrow(() => imageInfo(bytes.slice(0,end)));
});
test('image upload validates variants before writing, groups library entries and restores dimensions through backup', async (t) => {
  const f = await fixture(t); await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  assert.equal((await upload(f,webp(320,240))).status,400);
  assert.equal((await bucket.list({prefix:'uploads/'})).objects.length,0);
  const response = await upload(f);
  assert.equal(response.status,201,await response.clone().text());
  const image = await response.json(), variantKey = image.key + '.w640.webp';
  assert.equal(image.width,2048); assert.equal(image.height,1536);
  assert.match(image.srcset,/640w/); assert.equal(image.thumbnailKey,variantKey);
  assert.equal((await (await f.request('/api/images')).json()).images.length,1);
  const saved = await (await f.request('/api/posts/protected','PUT',{draft:draft('protected','![derived](/images/' + variantKey + ')'),etag:null})).json();
  let record = (await (await f.request('/api/images')).json()).images[0];
  assert.equal(record.references[0].kind,'draft');
  assert.equal((await f.request('/api/images','DELETE',record)).status,409);
  const pending = await f.prepare({slug:'protected',etag:saved.etag});
  await f.stage(pending,[], '<html><head></head><body><div class="article-body"><img src="/images/' + image.key + '"></div></body></html>');
  assert.equal((await f.commit(pending)).status,200);
  const html = await (await f.request('/posts/protected/')).text();
  assert.match(html,/width="2048" height="1536"/); assert.match(html,/srcset=/); assert.match(html,/data-full-src=/);
  const backup = await (await f.request('/api/backup')).json();
  assert.equal(backup.images.length,2);
  const target = await fixture(t); await target.login();
  for (const item of backup.images) {
    const bytes = new Uint8Array(await (await bucket.get(item.key)).arrayBuffer());
    assert.equal((await target.request('/api/backup/image?key='+encodeURIComponent(item.key),'PUT',bytes)).status,200);
  }
  assert.equal((await target.request('/api/backup/restore','POST',{backup,settings_etag:null})).status,200);
  record = (await (await target.request('/api/images')).json()).images[0];
  assert.equal(record.width,2048); assert.equal(record.height,1536);
  assert.match(record.srcset,/640w/);
});
test('unreferenced image deletion removes original and derivatives, and rejects deleting a derivative alone', async (t) => {
  const f = await fixture(t); await f.login();
  const image = await (await upload(f)).json(), bucket = await f.mf.getR2Bucket('STORAGE');
  const record = (await (await f.request('/api/images')).json()).images[0], derivative = await bucket.head(image.key + '.w640.webp');
  assert.equal((await f.request('/api/images','DELETE',{key:derivative.key,etag:derivative.etag})).status,400);
  assert.equal((await f.request('/api/images','DELETE',{...record,etag:'stale'})).status,409);
  assert.equal((await f.request('/api/images','DELETE',record)).status,200);
  assert.equal((await bucket.list({prefix:'uploads/'})).objects.length,0);
});
