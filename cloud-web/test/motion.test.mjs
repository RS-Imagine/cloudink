import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync('assets/motion.js', 'utf8');
function harness() {
  let now = 0,
    id = 0;
  const frames = new Map(),
    visibility = new Map();
  const media = {
    matches: false,
    addEventListener(_, fn) {
      this.change = fn;
    },
  };
  const document = {
    hidden: false,
    addEventListener(name, fn) {
      visibility.set(name, fn);
    },
  };
  const context = {
    document,
    matchMedia: () => media,
    requestAnimationFrame(fn) {
      frames.set(++id, fn);
      return id;
    },
    cancelAnimationFrame(key) {
      frames.delete(key);
    },
  };
  runInNewContext(source, context);
  function advance(ms = 16.6667) {
    now += ms;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  }
  function settle() {
    for (let i = 0; i < 600 && frames.size; i++) advance();
    assert.equal(frames.size, 0);
  }
  return {
    api: context.CloudInkMotion,
    frames,
    media,
    document,
    advance,
    settle,
    visibility: () => visibility.get('visibilitychange')(),
  };
}
const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, a + ' != ' + b);

test('physical solver agrees with the critical analytical trajectory and frame partitions', () => {
  const { api } = harness();
  const params = { mass: 1, stiffness: 400, damping: 40 };
  const state = { value: 0, target: 1, velocity: 0 };
  api.step(state, 0.2, params);
  near(state.value, 1 - 5 * Math.exp(-4));
  for (const damping of [10, 40, 60]) {
    const whole = { value: -1, target: 2, velocity: 3 },
      parts = { ...whole };
    const physics = { ...params, damping };
    api.step(whole, 0.3, physics);
    for (let i = 0; i < 30; i++) api.step(parts, 0.01, physics);
    near(whole.value, parts.value);
    near(whole.velocity, parts.velocity);
    api.step(parts, 1000, physics);
    near(parts.value, 2);
    near(parts.velocity, 0);
  }
});

test('underdamped springs overshoot naturally; damping dissipates mechanical energy', () => {
  const { api } = harness();
  const physics = { mass: 1, stiffness: 100, damping: 8 };
  const state = { value: 0, target: 1, velocity: 0 };
  let maximum = 0,
    energy = 50;
  for (let i = 0; i < 300; i++) {
    api.step(state, 0.01, physics);
    maximum = Math.max(maximum, state.value);
    const next = 50 * (state.value - 1) ** 2 + 0.5 * state.velocity ** 2;
    assert.ok(next <= energy + 1e-9);
    energy = next;
  }
  assert.ok(maximum > 1.1);
  near(state.value, 1, 0.00001);
});

test('retargeting preserves position and velocity, explicit release velocity is supported', () => {
  const h = harness();
  let completed = 0;
  const spring = h.api.spring({ onComplete: () => completed++ });
  spring.to(1);
  h.advance();
  h.advance();
  const value = spring.value,
    velocity = spring.velocity;
  spring.to(-1);
  near(spring.value, value);
  near(spring.velocity, velocity);
  spring.to(2, 4);
  near(spring.value, value);
  near(spring.velocity, 4);
  h.settle();
  near(spring.value, 2);
  near(spring.velocity, 0);
  assert.equal(completed, 1);
  assert.equal(h.api.stats().framePending, false);
});

test('all springs share one RAF, stop and jump leave no idle callbacks', () => {
  const h = harness();
  const a = h.api.spring(),
    b = h.api.spring();
  a.to(1);
  b.to(-2);
  assert.equal(h.frames.size, 1);
  h.advance();
  a.stop();
  b.jump(5);
  assert.equal(h.frames.size, 0);
  near(b.value, 5);
  near(b.velocity, 0);
  for (const options of [{ mass: 0 }, { stiffness: -1 }, { damping: 0 }, { from: NaN }])
    assert.throws(() => h.api.spring(options));
  assert.throws(() => a.to(Infinity));
});

test('retargeting from update cannot run stale completion or revisit a spring in the same frame', () => {
  const h = harness();
  let redirected = false,
    completed = 0,
    count = 0;
  const spring = h.api.spring({
    onUpdate(value) {
      count++;
      if (value === 1 && !redirected) {
        redirected = true;
        spring.to(2);
      }
    },
    onComplete() {
      completed++;
    },
  });
  spring.to(1);
  for (let i = 0; i < 300 && !redirected; i++) {
    const before = count;
    h.advance();
    assert.ok(count - before <= 1);
  }
  assert.equal(redirected, true);
  assert.equal(completed, 0);
  h.settle();
  assert.equal(completed, 1);
  near(spring.value, 2);
});

test('visibility pauses time and reduced motion finishes active and future springs immediately', () => {
  const h = harness();
  let completed = 0;
  const spring = h.api.spring({ onComplete: () => completed++ });
  spring.to(1);
  h.advance();
  const before = spring.value;
  h.document.hidden = true;
  h.visibility();
  h.advance(300000);
  near(spring.value, before);
  h.document.hidden = false;
  h.visibility();
  h.advance();
  assert.ok(spring.value > before && spring.value < 0.5);
  h.media.matches = true;
  h.media.change();
  near(spring.value, 1);
  assert.equal(h.frames.size, 0);
  spring.to(-2);
  near(spring.value, -2);
  assert.equal(completed, 2);
  assert.equal(h.frames.size, 0);
});
