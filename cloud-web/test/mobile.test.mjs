import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const context = {};
runInNewContext(readFileSync('assets/mobile.js', 'utf8'), context);
const snap = context.CloudInkMobile.snapTarget;
test('sheets settle at the nearest open detent for slow releases', () => {
  assert.equal(snap({ offset: 40, velocity: 0, height: 700, peek: 240 }), 'expanded');
  assert.equal(snap({ offset: 180, velocity: 0, height: 700, peek: 240 }), 'peek');
  assert.equal(snap({ offset: 510, velocity: 0, height: 700, peek: 240 }), 'closed');
});
test('release velocity contributes direction without dismissing a tiny accidental move', () => {
  assert.equal(snap({ offset: 80, velocity: 1100, height: 700, peek: 240 }), 'closed');
  assert.notEqual(snap({ offset: 12, velocity: 1000, height: 700, peek: 240 }), 'closed');
  assert.equal(snap({ offset: 200, velocity: -1100, height: 700, peek: 240 }), 'expanded');
});
test('compact sheets have no artificial middle detent', () => {
  assert.equal(snap({ offset: 100, velocity: 0, height: 300 }), 'expanded');
  assert.equal(snap({ offset: 240, velocity: 0, height: 300 }), 'closed');
});
test('invalid or collapsed geometry does not turn a release into dismissal', () => {
  for (const input of [
    { offset: 20, velocity: NaN, height: 700 },
    { offset: 20, velocity: 0, height: 0 },
    { offset: Infinity, velocity: 0, height: 700 },
  ])
    assert.equal(snap(input), 'expanded');
});
