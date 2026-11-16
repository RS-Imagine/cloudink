/* Shared, framework-free motion. Classic script also embeds directly in Rust output. */
(() => {
  if (globalThis.CloudInkMotion) return;
  const env = globalThis,
    doc = env.document;
  const media = env.matchMedia?.('(prefers-reduced-motion: reduce)');
  const springs = new Set(),
    effects = new Set(),
    mounts = new Set();
  const current = new WeakMap(),
    dialogs = new WeakMap(),
    mounted = new WeakMap();
  let frame = 0,
    last = null,
    sequence = 0;
  const reduced = () => !!media?.matches;
  const response = Object.freeze({ stiffness: 360, dampingRatio: 0.72 });
  let curve;
  function springCurve() {
    if (curve) return curve;
    const state = { value: 0, target: 1, velocity: 0 };
    const values = [0];
    for (let i = 0; i < 90; i++) {
      step(state, 1 / 60, response);
      values.push(state.value);
      if (Math.abs(state.value - 1) < 0.001 && Math.abs(state.velocity) < 0.01) break;
    }
    values[values.length - 1] = 1;
    const easing = `linear(${values.map((value) => value.toFixed(4)).join(',')})`;
    curve = {
      duration: ((values.length - 1) * 1000) / 60,
      easing: env.CSS?.supports('transition-timing-function', easing)
        ? easing
        : 'cubic-bezier(0.34,1.56,0.64,1)',
    };
    return curve;
  }
  const rubberBand = (x, d = 1, c = 0.55) => (!d ? 0 : (x * d * c) / (d + c * Math.abs(x)));
  function step(
    state,
    dt,
    {
      mass = 1,
      stiffness = 420,
      damping,
      dampingRatio = 1,
      bounds,
      bounce,
      restitution = 0.35,
    } = {},
  ) {
    const c = damping ?? 2 * dampingRatio * Math.sqrt(mass * stiffness);
    const a = c / (2 * mass),
      d = a * a - stiffness / mass;
    const y = state.value - state.target,
      v = state.velocity;
    let next, velocity;
    if (Math.abs(d) < 1e-8) {
      const b = v + a * y,
        decay = Math.exp(-a * dt);
      next = (y + b * dt) * decay;
      velocity = (v - a * b * dt) * decay;
    } else if (d < 0) {
      const w = Math.sqrt(-d),
        angle = w * dt,
        decay = Math.exp(-a * dt);
      const b = (v + a * y) / w;
      next = (y * Math.cos(angle) + b * Math.sin(angle)) * decay;
      velocity = -a * next + w * (-y * Math.sin(angle) + b * Math.cos(angle)) * decay;
    } else {
      const w = Math.sqrt(d),
        r1 = -a + w,
        r2 = -a - w;
      const b = (v - r2 * y) / (r1 - r2);
      const first = b * Math.exp(r1 * dt),
        second = (y - b) * Math.exp(r2 * dt);
      next = first + second;
      velocity = r1 * first + r2 * second;
    }
    let nextVal = state.target + next;
    if (bounds && bounce) {
      const r = typeof bounce === 'number' ? bounce : restitution;
      const hit =
        bounds[0] !== undefined && nextVal < bounds[0] && velocity < 0
          ? bounds[0]
          : bounds[1] !== undefined && nextVal > bounds[1] && velocity > 0
            ? bounds[1]
            : null;
      if (hit !== null) {
        nextVal = hit + (hit - nextVal) * r;
        velocity = -velocity * r;
      }
    }
    state.value = nextVal;
    state.velocity = velocity;
  }
  function schedule() {
    if (!frame && springs.size && !doc?.hidden) frame = env.requestAnimationFrame(tick);
  }
  function unschedule() {
    if (!springs.size && frame) {
      env.cancelAnimationFrame(frame);
      frame = 0;
      last = null;
    }
  }
  function tick(time) {
    frame = 0;
    const dt = last === null ? 1 / 60 : Math.min(0.05, Math.max(0, (time - last) / 1000));
    last = time;
    sequence++;
    for (const record of springs)
      if (record.sequence !== sequence) {
        record.sequence = sequence;
        record.tick(dt);
      }
    if (!springs.size) last = null;
    schedule();
  }
  function spring({
    from = 0,
    velocity = 0,
    mass = 1,
    stiffness = 420,
    damping,
    dampingRatio = response.dampingRatio,
    bounds,
    bounce = false,
    onUpdate = () => {},
    onComplete = () => {},
  } = {}) {
    for (const n of [from, velocity, mass, stiffness, damping ?? 1, dampingRatio ?? 1])
      if (!Number.isFinite(n)) throw new TypeError('Spring values must be finite');
    if (mass <= 0 || stiffness <= 0 || (damping ?? 1) <= 0 || (dampingRatio ?? 1) <= 0)
      throw new RangeError('Spring parameters must be positive');
    const state = { value: from, target: from, velocity };
    const physics = { mass, stiffness, damping, dampingRatio, bounds, bounce };
    let generation = 0;
    const record = {
      tick(dt) {
        const version = generation;
        step(state, dt, physics);
        if (Math.abs(state.value - state.target) < 0.0004 && Math.abs(state.velocity) < 0.004) {
          state.value = state.target;
          state.velocity = 0;
          springs.delete(record);
          onUpdate(state.value);
          if (version === generation) onComplete();
        } else onUpdate(state.value);
      },
      finish() {
        springs.delete(record);
        state.value = state.target;
        state.velocity = 0;
        const version = generation;
        onUpdate(state.value);
        if (version === generation) onComplete();
        unschedule();
      },
    };
    return {
      get value() {
        return state.value;
      },
      get velocity() {
        return state.velocity;
      },
      to(value, initialVelocity) {
        if (
          !Number.isFinite(value) ||
          (initialVelocity !== undefined && !Number.isFinite(initialVelocity))
        )
          throw new TypeError('Spring target and velocity must be finite');
        generation++;
        state.target = value;
        if (initialVelocity !== undefined) state.velocity = initialVelocity;
        if (reduced() || !env.requestAnimationFrame) record.finish();
        else {
          springs.add(record);
          schedule();
        }
      },
      stop() {
        generation++;
        springs.delete(record);
        unschedule();
      },
      jump(value, initialVelocity) {
        if (!Number.isFinite(value)) throw new TypeError('Spring value must be finite');
        generation++;
        springs.delete(record);
        state.value = state.target = value;
        state.velocity = initialVelocity !== undefined ? initialVelocity : 0;
        onUpdate(value);
        unschedule();
      },
    };
  }
  function transition(
    element,
    enter,
    { kind = 'dialog', onFinish, signal, delay = 0, axis = 'y', direction = 1 } = {},
  ) {
    const previous = current.get(element);
    const visual = previous ? env.getComputedStyle(element) : null;
    const distance = kind === 'reveal' ? 28 : kind === 'content' ? 24 : 16;
    const offset = axis === 'x' ? [distance * direction, 0] : [0, distance * direction];
    const start = {
      opacity: visual?.opacity ?? (enter ? 0 : 1),
      translate: visual?.translate || (enter ? `${offset[0]}px ${offset[1]}px` : '0 0'),
      scale: visual?.scale || (enter && kind === 'dialog' ? 0.96 : 1),
    };
    const end = {
      opacity: enter ? 1 : 0,
      translate: enter ? '0 0' : `${offset[0] * 0.5}px ${offset[1] * 0.5}px`,
      scale: enter || kind !== 'dialog' ? 1 : 0.98,
    };
    return animate(element, [start, end], {
      onFinish,
      signal,
      delay,
      duration: springCurve().duration * (enter ? 1 : 0.7),
    });
  }
  function animate(
    element,
    keyframes,
    { onFinish, signal, delay = 0, duration = springCurve().duration } = {},
  ) {
    current.get(element)?.cancel();
    if (signal?.aborted) return { finished: Promise.resolve(false), cancel() {} };
    if (reduced() || !element.animate || !element.isConnected) {
      onFinish?.();
      return { finished: Promise.resolve(true), cancel() {} };
    }
    let resolve,
      done = false;
    const finished = new Promise((r) => {
      resolve = r;
    });
    const animation = element.animate(keyframes, {
      duration,
      delay,
      easing: springCurve().easing,
      fill: 'both',
    });
    const settle = (ok) => {
      if (done) return;
      done = true;
      effects.delete(record);
      if (current.get(element) === record) current.delete(element);
      signal?.removeEventListener('abort', cancel);
      animation.onfinish = animation.oncancel = null;
      try {
        if (ok) onFinish?.();
      } finally {
        animation.cancel();
        resolve(ok);
      }
    };
    const cancel = () => settle(false);
    const record = { element, animation, finished, cancel, finish: () => settle(true) };
    current.set(element, record);
    effects.add(record);
    animation.onfinish = () => settle(true);
    animation.oncancel = cancel;
    signal?.addEventListener('abort', cancel, { once: true });
    if (doc.hidden) animation.pause();
    return record;
  }
  function cancelWithin(root) {
    for (const record of effects)
      if (root === record.element || root.contains(record.element)) record.cancel();
    for (const mount of mounts) mount.reset(root);
  }
  function openDialog(dialog) {
    let state = dialogs.get(dialog);
    if (!state) {
      state = { closing: false };
      dialogs.set(dialog, state);
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeDialog(dialog);
      });
      dialog.addEventListener('close', () => {
        if (dialog.open) return;
        state.closing = false;
        cancelWithin(dialog);
        dialog.style.opacity = '';
        dialog.style.transition = '';
      });
    }
    if (state.closing) dialog.returnValue = '';
    state.closing = false;
    dialog.style.opacity = '';
    dialog.style.transition = '';
    if (!dialog.open) dialog.showModal();
    if (env.CloudInkMobile?.openDialog(dialog)) return;
    transition(dialog, true);
  }
  function closeDialog(dialog) {
    const state = dialogs.get(dialog);
    if (!dialog.open || state?.closing) return;
    if (!state) {
      dialog.close();
      return;
    }
    state.closing = true;
    if (
      env.CloudInkMobile?.closeDialog(dialog, () => {
        if (state.closing && dialog.open) dialog.close();
      })
    )
      return;
    transition(dialog, false, {
      onFinish() {
        dialog.style.transition = 'none';
        dialog.style.opacity = '0';
        if (state.closing && dialog.open) dialog.close();
      },
    });
  }
  function followSelection(root) {
    const indicator = doc.createElement('span');
    indicator.className = 'ci-selection';
    indicator.setAttribute('aria-hidden', 'true');
    indicator.hidden = true;
    root.append(indicator);
    const values = [0, 0];
    const draw = () => {
      indicator.style.transform = `translate(${values[0]}px,${values[1]}px)`;
    };
    const axes = values.map((from, index) =>
      spring({
        from,
        ...response,
        onUpdate(value) {
          values[index] = value;
          draw();
        },
      }),
    );
    function sync(animate = true) {
      const selected = root.querySelector(
        '[aria-current],[aria-selected="true"],[aria-pressed="true"]',
      );
      if (!selected?.offsetWidth || !selected.offsetHeight || !root.isConnected) {
        axes.forEach((axis) => axis.stop());
        indicator.hidden = true;
        return;
      }
      const next = [selected.offsetLeft, selected.offsetTop];
      const first = indicator.hidden;
      indicator.hidden = false;
      indicator.style.borderRadius = env.getComputedStyle(selected).borderRadius;
      root.dataset.ciSelection = '';
      indicator.style.width = selected.offsetWidth + 'px';
      indicator.style.height = selected.offsetHeight + 'px';
      axes.forEach((axis, index) => {
        if (!first && animate) axis.to(next[index]);
        else axis.jump(next[index]);
      });
    }
    const mutations = new env.MutationObserver((changes) => {
      if (changes.some((change) => change.target !== indicator)) sync();
    });
    mutations.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-current', 'aria-selected', 'aria-pressed', 'hidden'],
    });
    const resize = env.ResizeObserver ? new env.ResizeObserver(() => sync(false)) : null;
    resize?.observe(root);
    sync(false);
    return {
      root,
      reset: () => sync(false),
      dispose() {
        mutations.disconnect();
        resize?.disconnect();
        axes.forEach((axis) => axis.stop());
        indicator.remove();
        delete root.dataset.ciSelection;
      },
    };
  }
  function mount(root = doc) {
    if (mounted.has(root)) return mounted.get(root);
    doc.documentElement.dataset.ciMotion = '';
    for (const name of ['--ci-ease', '--ci-ease-out', '--ci-ease-in'])
      doc.documentElement.style.setProperty(name, springCurve().easing);
    const abort = new AbortController(),
      records = new WeakMap(),
      live = new Set(),
      pointers = new Map();
    const selections = env.MutationObserver
      ? Array.from(
          root.querySelectorAll(
            '.reader-side-nav,.reader-dock,.studio-nav,.post-filters,.editor-view-switch',
          ),
          followSelection,
        )
      : [];
    const buttonAt = (event) =>
      event.target.closest?.('button,a[href],summary,[role="button"],[data-motion-press]');
    function press(button) {
      if (
        !button ||
        button.disabled ||
        button.getAttribute('aria-disabled') === 'true' ||
        reduced() ||
        !('scale' in button.style)
      )
        return;
      let record = records.get(button);
      if (!record) {
        record = { button, original: button.style.scale, held: false, time: 0 };
        record.spring = spring({
          from: 1,
          dampingRatio: response.dampingRatio,
          stiffness: 420,
          onUpdate(value) {
            if (!button.isConnected) {
              record.spring.stop();
              live.delete(record);
              return;
            }
            button.style.scale = String(value);
          },
          onComplete() {
            if (!record.held) {
              button.style.scale = record.original;
              live.delete(record);
            }
          },
        });
        records.set(button, record);
      }
      record.held = true;
      record.time = performance.now();
      live.add(record);
      record.spring.to(0.965);
    }
    function release(button) {
      const record = button && records.get(button);
      if (record?.held) {
        record.held = false;
        const elapsed = performance.now() - (record.time || 0);
        const velocity = elapsed < 250 ? Math.min(2.5, Math.max(0.5, (250 - elapsed) / 80)) : 0;
        record.spring.to(1, velocity);
      }
    }
    const listen = (target, name, handler) =>
      target.addEventListener(name, handler, { signal: abort.signal });
    const binding = {
      reset(container = root) {
        for (const selection of selections)
          if (container === root || container.contains(selection.root)) selection.reset();
        for (const record of live)
          if (container === root || container.contains(record.button)) {
            record.held = false;
            record.spring.stop();
            record.button.style.scale = record.original;
            records.delete(record.button);
            live.delete(record);
          }
        for (const [id, button] of pointers)
          if (container === root || container.contains(button)) pointers.delete(id);
      },
      dispose() {
        binding.reset();
        selections.forEach((selection) => selection.dispose());
        abort.abort();
        mounts.delete(binding);
        mounted.delete(root);
      },
    };
    listen(root, 'pointerdown', (event) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      const button = buttonAt(event);
      if (button) {
        pointers.set(event.pointerId, button);
        press(button);
      }
    });
    const pointerEnd = (event) => {
      release(pointers.get(event.pointerId));
      pointers.delete(event.pointerId);
    };
    listen(root, 'pointerup', pointerEnd);
    listen(root, 'pointercancel', pointerEnd);
    listen(root, 'lostpointercapture', pointerEnd);
    listen(root, 'keydown', (event) => {
      if (!event.repeat && (event.key === ' ' || event.key === 'Enter')) press(buttonAt(event));
    });
    listen(root, 'keyup', (event) => {
      if (event.key === ' ' || event.key === 'Enter') release(buttonAt(event));
    });
    listen(root, 'focusout', (event) => release(buttonAt(event)));
    root.addEventListener(
      'toggle',
      (event) => {
        if (event.target.tagName !== 'DETAILS' || !event.target.open) return;
        for (const child of event.target.children)
          if (child.tagName !== 'SUMMARY') transition(child, true, { kind: 'content' });
      },
      { signal: abort.signal, capture: true },
    );
    listen(env, 'blur', () => binding.reset());
    listen(env, 'pagehide', () => {
      binding.reset();
      cancelWithin(root);
    });
    mounted.set(root, binding);
    mounts.add(binding);
    return binding;
  }
  media?.addEventListener('change', () => {
    if (!reduced()) return;
    for (const binding of mounts) binding.reset();
    for (const record of springs) record.finish();
    for (const record of effects) record.finish();
  });
  doc?.addEventListener('visibilitychange', () => {
    last = null;
    if (doc.hidden) {
      if (frame) env.cancelAnimationFrame(frame);
      frame = 0;
      for (const binding of mounts) binding.reset();
    } else schedule();
    for (const record of effects) doc.hidden ? record.animation.pause() : record.animation.play();
  });
  env.CloudInkMotion = Object.freeze({
    response,
    animate,
    spring,
    step,
    rubberBand,
    mount,
    cancelWithin,
    openDialog,
    closeDialog,
    enter: (element, options) => transition(element, true, options),
    exit: (element, options) => transition(element, false, options),
    stats: () => ({ springs: springs.size, effects: effects.size, framePending: !!frame }),
  });
})();
