import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishInBrowser } from '../../cloud-admin/ui/publication.js';

function publication({ commit, cancel, refresh = async () => {} } = {}) {
  const result = { release_id: 'current', files: ['index.html', '_release.json'] };
  const deployed = { ...result, status: 'deployed' };
  const notices = [],
    states = [],
    requests = [];
  return {
    deployed,
    notices,
    states,
    requests,
    run: () =>
      publishInBrowser(result, {
        engineTask: async () => ({
          'index.html': '<h1>Published</h1>',
          '_release.json': JSON.stringify({ id: 'current' }),
        }),
        api: async (path) => {
          requests.push(path);
          if (path.endsWith('/commit')) return commit ? commit(deployed) : deployed;
          if (path.endsWith('/cancel'))
            return cancel ? cancel(deployed) : { ...result, status: 'failed' };
          return {};
        },
        showPublishing: (state) => states.push(state),
        refresh,
        notice: (message, tone) => notices.push({ message, tone }),
      }),
  };
}

test('publication returns the confirmed release and reports success once', async () => {
  const p = publication();
  assert.deepEqual(await p.run(), p.deployed);
  assert.equal(p.notices.length, 1);
  assert.equal(p.notices[0].tone, 'success');
  assert.ok(!p.requests.some((path) => path.endsWith('/cancel')));
});

test('a list refresh failure after commit cannot report a failed publication', async () => {
  const p = publication({
    refresh: async () => {
      throw new Error('Offline list');
    },
  });
  assert.deepEqual(await p.run(), p.deployed);
  assert.equal(p.states.at(-1).status, 'deployed');
  assert.equal(p.notices.length, 1);
  assert.match(p.notices[0].message, /已上线.*暂未刷新/);
  assert.equal(p.notices[0].tone, 'info');
  assert.ok(!p.requests.some((path) => path.endsWith('/cancel')));
});

test('a lost commit response is successful only when the same release is confirmed deployed', async () => {
  const p = publication({
    commit: async () => {
      throw new Error('Lost commit response');
    },
    cancel: async (deployed) => deployed,
  });
  assert.deepEqual(await p.run(), p.deployed);
  assert.equal(p.notices.length, 1);
  assert.equal(p.notices[0].tone, 'success');
});

test('failed, unconfirmed and mismatched releases never emit a success notice', async () => {
  for (const options of [
    {
      commit: async () => {
        throw new Error('Upload rejected');
      },
    },
    {
      commit: async () => {
        throw new Error('Offline');
      },
      cancel: async () => {
        throw new Error('Offline');
      },
    },
    {
      commit: async (deployed) => ({ ...deployed, release_id: 'another' }),
      cancel: async (deployed) => ({ ...deployed, release_id: 'another' }),
    },
  ]) {
    const p = publication(options);
    await assert.rejects(p.run());
    assert.equal(p.notices.length, 0);
    assert.ok(!p.states.some((state) => state.status === 'deployed'));
  }
});
