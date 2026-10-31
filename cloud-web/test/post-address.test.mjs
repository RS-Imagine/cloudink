import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, draft, origin } from './fixture.mjs';

async function save(f, slug, body = 'Original body', etag = null) {
  const response = await f.request('/api/posts/' + slug, 'PUT', { draft: draft(slug, body), etag });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function publish(f, body) {
  const state = await f.prepare(body);
  await f.stage(state);
  const response = await f.commit(state);
  assert.equal(response.status, 200, await response.clone().text());
  return state;
}
async function redirect(f, from, to) {
  for (const method of ['GET', 'HEAD']) {
    const response = await f.mf.dispatchFetch(origin + '/posts/' + from + '/?source=old', {
      method,
      redirect: 'manual',
    });
    assert.equal(response.status, 301);
    assert.equal(response.headers.get('Location'), origin + '/posts/' + to + '/?source=old');
  }
}

test('saved draft can move without publishing or changing its body; retries are idempotent', async (t) => {
  const f = await fixture(t);
  await f.login();
  const original = await save(f, 'draft-old', '# Keep this body\n\n**Text** $x^2$');
  const request = { slug: 'draft-new', etag: original.etag };
  const first = await f.request('/api/posts/draft-old/rename', 'POST', request);
  assert.equal(first.status, 200, await first.clone().text());
  const moved = await first.json();
  assert.equal(moved.draft.front_matter.slug, 'draft-new');
  assert.equal(moved.draft.front_matter.aliases, undefined);
  assert.equal(moved.draft.body_markdown, original.draft.body_markdown);
  assert.equal((await f.request('/posts/draft-new/')).status, 404);
  assert.equal((await f.request('/api/posts/draft-old')).status, 404);
  assert.equal((await f.request('/api/posts/draft-new')).status, 200);
  assert.equal((await f.request('/api/posts/draft-old/rename', 'POST', request)).status, 200);
  const bucket = await f.mf.getR2Bucket('STORAGE');
  assert.equal((await bucket.head('drafts/draft-old.md')).customMetadata.deleted, 'true');
  assert.ok(!(await (await bucket.get('drafts/draft-old.md')).text()).includes('Keep this body'));
  const list = await (await f.request('/api/posts')).json();
  assert.deepEqual(
    list.posts.map((post) => post.slug),
    ['draft-new'],
  );
  assert.equal(
    (
      await f.request('/api/posts/draft-old', 'PUT', {
        draft: original.draft,
        etag: original.etag,
      })
    ).status,
    409,
  );
});

test('rename rejects occupied, invalid, stale and unauthenticated requests without overwriting either draft', async (t) => {
  const f = await fixture(t);
  await f.login();
  const a = await save(f, 'source', 'Source body');
  const b = await save(f, 'occupied', 'Destination body');
  assert.equal(
    (await f.request('/api/posts/source/rename', 'POST', { slug: 'occupied', etag: a.etag }))
      .status,
    409,
  );
  assert.equal(
    (await f.request('/api/posts/source/rename', 'POST', { slug: 'new', etag: 'stale' })).status,
    409,
  );
  for (const slug of ['', '../escape', 'bad/slash', 'x'.repeat(101), '中文', 'https://evil.test'])
    assert.equal(
      (await f.request('/api/posts/source/rename', 'POST', { slug, etag: a.etag })).status,
      400,
    );
  assert.equal(
    (
      await f.request(
        '/api/posts/source/rename',
        'POST',
        { slug: 'new', etag: a.etag },
        { 'X-CSRF-Token': 'wrong' },
      )
    ).status,
    403,
  );
  assert.equal((await (await f.request('/api/posts/source')).json()).source, a.source);
  assert.equal((await (await f.request('/api/posts/occupied')).json()).source, b.source);
  const results = await Promise.all(
    ['one', 'two'].map((slug) =>
      f.request('/api/posts/source/rename', 'POST', { slug, etag: a.etag }),
    ),
  );
  assert.equal(results.filter((response) => response.status === 200).length, 1);
  const list = await (await f.request('/api/posts')).json();
  assert.equal(list.posts.length, 2);
});

test('a draft move recovers the copy-complete cleanup-interrupted state', async (t) => {
  const f = await fixture(t);
  await f.login();
  const original = await save(f, 'before', 'Recoverable body');
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const metadata = (await bucket.head('drafts/before.md')).customMetadata;
  const input = { slug: 'after', etag: original.etag };
  assert.equal((await f.request('/api/posts/before/rename', 'POST', input)).status, 200);
  // Recreate the state after copying the target but before retiring the source.
  await bucket.put('drafts/before.md', original.source, { customMetadata: metadata });
  assert.equal((await f.request('/api/posts/before/rename', 'POST', input)).status, 200);
  const posts = await (await f.request('/api/posts')).json();
  assert.deepEqual(
    posts.posts.map((post) => post.slug),
    ['after'],
  );
});

test('published rename is staged, cancellable, atomic and preserves unrelated drafts and redirects', async (t) => {
  const f = await fixture(t);
  await f.login();
  const a = await save(f, 'a', 'Published source');
  await save(f, 'private', 'Must stay private');
  await publish(f, { slug: 'a', etag: a.etag });
  const cancelled = await f.prepare({ slug: 'a', etag: a.etag, renameTo: 'b' });
  assert.equal((await f.request('/posts/a/')).status, 200);
  assert.equal((await f.request('/posts/b/')).status, 404);
  await f.request('/api/publish/' + cancelled.release_id + '/cancel', 'POST', {});
  assert.equal((await f.request('/posts/a/')).status, 200);
  assert.equal((await f.request('/api/posts/a')).status, 200);
  const renamed = await publish(f, { slug: 'a', etag: a.etag, renameTo: 'b' });
  assert.equal(renamed.browser_release.markdown_posts.a, undefined);
  assert.equal(renamed.browser_release.markdown_posts.private, undefined);
  assert.match(renamed.browser_release.markdown_posts.b, /Published source/);
  await redirect(f, 'a', 'b');
  assert.equal((await f.request('/posts/b/')).status, 200);
  assert.equal((await f.request('/posts/private/')).status, 404);
  assert.equal(
    (await f.request('/api/posts/a', 'PUT', { draft: a.draft, etag: a.etag })).status,
    409,
  );
  // Later publication cancellation must retain the established redirect map.
  const pending = await f.prepare({ rebuild: true });
  await f.request('/api/publish/' + pending.release_id + '/cancel', 'POST', {});
  await redirect(f, 'a', 'b');
  const b = await (await f.request('/api/posts/b')).json();
  const savedB = await f.request('/api/posts/b', 'PUT', {
    draft: { ...b.draft, body_markdown: 'Next body' },
    etag: b.etag,
  });
  const stateB = await savedB.json();
  await publish(f, { slug: 'b', etag: stateB.etag, renameTo: 'c' });
  await redirect(f, 'a', 'c');
  await redirect(f, 'b', 'c');
  const c = await (await f.request('/api/posts/c')).json();
  const savedC = await f.request('/api/posts/c', 'PUT', { draft: c.draft, etag: c.etag });
  await publish(f, { slug: 'c', etag: (await savedC.json()).etag, renameTo: 'a' });
  assert.equal((await f.request('/posts/a/')).status, 200);
  await redirect(f, 'b', 'a');
  await redirect(f, 'c', 'a');
  await publish(f, { unpublish: 'a' });
  for (const slug of ['a', 'b', 'c'])
    assert.equal((await f.request('/posts/' + slug + '/')).status, 404);
  assert.match((await (await f.request('/api/posts/a')).json()).draft.body_markdown, /Next body/);
  const backup = await (await f.request('/api/backup')).json();
  assert.match(backup.files['drafts/a.md'], /aliases/);
});

test('rename commit rejects changed source or destination while retaining the previous public version', async (t) => {
  const f = await fixture(t);
  await f.login();
  const original = await save(f, 'live', 'Original public content');
  await publish(f, { slug: 'live', etag: original.etag });
  const pending = await f.prepare({ slug: 'live', etag: original.etag, renameTo: 'new' });
  assert.equal(
    (await f.request('/api/posts/new', 'PUT', { draft: draft('new'), etag: null })).status,
    409,
  );
  const changed = await save(f, 'live', 'Newer saved changes', original.etag);
  await f.stage(pending);
  assert.equal((await f.commit(pending)).status, 409);
  assert.equal((await f.request('/posts/live/')).status, 200);
  assert.equal((await f.request('/posts/new/')).status, 404);
  assert.equal((await (await f.request('/api/posts/live')).json()).etag, changed.etag);
  await f.request('/api/publish/' + pending.release_id + '/cancel', 'POST', {});
  const next = await f.prepare({ slug: 'live', etag: changed.etag, renameTo: 'new' });
  await f.stage(next);
  const bucket = await f.mf.getR2Bucket('STORAGE');
  await bucket.put('drafts/new.md', original.source.replace('slug = "live"', 'slug = "new"'));
  assert.equal((await f.commit(next)).status, 409);
  assert.equal((await f.request('/posts/live/')).status, 200);
  assert.equal((await f.request('/posts/new/')).status, 404);
  assert.equal((await f.request('/api/posts/new')).status, 200);
});
