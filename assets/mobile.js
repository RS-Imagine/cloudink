/* Shared mobile sheets. No framework, persistence, data requests or idle animation loop. */
(() => {
  if (globalThis.CloudInkMobile) return;
  const env = globalThis,
    doc = env.document;
  const records = new WeakMap(),
    active = new Set();
  let sequence = 0,
    viewportFrame = 0,
    baselineHeight = 0,
    lastViewportHeight = 0,
    lastViewportWidth = 0;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  function snapTarget({ offset, velocity, height, peek = 0 }) {
    if (![offset, velocity, height, peek].every(Number.isFinite) || height <= 0) return 'expanded';
    const projected = offset + clamp(velocity, -3000, 3000) * 0.16;
    if ((offset > 36 && velocity > 900) || projected > height * 0.68) return 'closed';
    return peek > 16 && projected > peek * 0.5 ? 'peek' : 'expanded';
  }
  function viewportHeight() {
    return env.visualViewport?.height || env.innerHeight || 1;
  }
  function attach(surface, { media = '(max-width:759px)', onDismiss = () => {} } = {}) {
    if (records.has(surface)) return records.get(surface);
    const motion = env.CloudInkMotion,
      narrow = env.matchMedia(media);
    const abort = new AbortController(),
      signal = abort.signal;
    const handle = doc.createElement('button');
    handle.type = 'button';
    handle.className = 'ci-sheet-grip';
    handle.setAttribute('aria-description', '上下方向键调整面板，Esc 关闭');
    if (!surface.id) surface.id = 'ci-sheet-' + ++sequence;
    handle.setAttribute('aria-controls', surface.id);
    surface.prepend(handle);
    let height = 1,
      peek = 0,
      position = 0,
      target = 0,
      phase = 'idle';
    let gesture = null,
      suppressUntil = 0,
      completion = null,
      resizeFrame = 0,
      pendingHeight = 0;
    const originalTranslate = surface.style.translate;
    const native = typeof surface.showModal === 'function';
    function label() {
      const expanded = target === 0;
      handle.setAttribute('aria-label', peek ? (expanded ? '收起面板' : '展开面板') : '关闭面板');
      if (peek) handle.setAttribute('aria-expanded', String(expanded));
      else handle.removeAttribute('aria-expanded');
      surface.dataset.sheetSnap = phase === 'closing' ? 'closing' : expanded ? 'expanded' : 'peek';
    }
    function draw(value) {
      position = value;
      surface.style.translate = '0 ' + (value * height).toFixed(2) + 'px';
    }
    const spring = motion.spring({
      from: 0,
      mass: 1,
      stiffness: 320,
      damping: 34,
      onUpdate: draw,
      onComplete() {
        if (!active.has(record)) return;
        if (phase === 'closing') {
          const done = completion || onDismiss;
          record.reset();
          done();
        } else {
          phase = 'rest';
          surface.style.setProperty('--ci-sheet-reserve', Math.max(0, target * height) + 'px');
          label();
        }
      },
    });
    function measure(nextHeight = surface.offsetHeight) {
      if (!active.has(record)) return;
      const measuredHeight = Math.max(1, nextHeight);
      if (Math.abs(measuredHeight - height) < 0.5) return;
      height = measuredHeight;
      peek =
        surface.dataset.sheet === 'list'
          ? clamp(1 - (viewportHeight() * 0.58) / height, 0, 0.65)
          : 0;
      if (!gesture && phase !== 'closing') {
        if (target > 0) target = peek;
        spring.to(target);
        label();
      }
      draw(position);
    }
    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver((entries) => {
            const size = entries[0]?.borderBoxSize;
            pendingHeight = size?.[0]?.blockSize || size?.blockSize || surface.offsetHeight;
            if (!resizeFrame)
              resizeFrame = requestAnimationFrame(() => {
                resizeFrame = 0;
                measure(pendingHeight);
              });
          })
        : null;
    function moveTo(next, velocity) {
      target = next;
      phase = 'settling';
      completion = null;
      label();
      spring.to(target, velocity);
    }
    function dismiss(velocity) {
      if (native && motion) {
        motion.closeDialog(surface);
        if (phase === 'closing' && velocity !== undefined) spring.to(1.05, velocity);
      } else record.close(onDismiss, velocity);
    }
    function finishGesture(cancelled) {
      if (!gesture) return;
      const current = gesture;
      gesture = null;
      try {
        handle.releasePointerCapture(current.id);
      } catch {}
      if (!cancelled && !current.moved) return;
      if (!cancelled) suppressUntil = performance.now() + 250;
      const velocity = cancelled || performance.now() - current.time > 100 ? 0 : current.velocity;
      const stop = snapTarget({ offset: position * height, velocity, height, peek: peek * height });
      if (cancelled) moveTo(target > 0 ? peek : 0, 0);
      else if (stop === 'closed') dismiss(velocity / height);
      else moveTo(stop === 'peek' ? peek : 0, velocity / height);
    }
    const record = {
      surface,
      handle,
      open() {
        if (!narrow.matches || !surface.isConnected) return false;
        const first = !active.has(record);
        completion = null;
        active.add(record);
        surface.dataset.ciSheetActive = '';
        height = Math.max(1, surface.offsetHeight);
        peek =
          surface.dataset.sheet === 'list'
            ? clamp(1 - (viewportHeight() * 0.58) / height, 0, 0.65)
            : 0;
        if (first) spring.jump(1.05);
        target = surface.dataset.sheet === 'list' ? peek : 0;
        phase = 'opening';
        label();
        observer?.observe(surface);
        spring.to(target);
        return true;
      },
      close(done = onDismiss, velocity) {
        if (!active.has(record)) return false;
        const captured = gesture?.id;
        gesture = null;
        if (captured !== undefined) {
          try {
            handle.releasePointerCapture(captured);
          } catch {}
        }
        completion = done;
        target = 1.05;
        phase = 'closing';
        label();
        spring.to(target, velocity);
        return true;
      },
      reset() {
        spring.stop();
        if (gesture) {
          const id = gesture.id;
          gesture = null;
          try {
            handle.releasePointerCapture(id);
          } catch {}
        }
        observer?.disconnect();
        if (resizeFrame) cancelAnimationFrame(resizeFrame);
        resizeFrame = 0;
        active.delete(record);
        phase = 'idle';
        completion = null;
        surface.style.translate = originalTranslate;
        surface.style.removeProperty('--ci-sheet-reserve');
        delete surface.dataset.ciSheetActive;
        delete surface.dataset.sheetSnap;
      },
      refresh(resized = false) {
        if (resized && gesture) finishGesture(true);
        if (!narrow.matches) {
          record.reset();
          onDismiss();
          if (native && surface.open) surface.close();
          return;
        }
        if (!observer) measure();
        if (
          surface.contains(doc.activeElement) &&
          doc.activeElement.matches('input,textarea,[contenteditable=true]') &&
          !gesture &&
          phase !== 'closing'
        )
          moveTo(0);
      },
      get resizePending() {
        return !!resizeFrame;
      },
      cancelGesture() {
        finishGesture(true);
      },
      closeImmediately() {
        record.reset();
        if (native && surface.open) surface.close();
        else onDismiss();
      },
      dispose() {
        record.reset();
        abort.abort();
        handle.remove();
        records.delete(surface);
      },
    };
    records.set(surface, record);
    handle.addEventListener(
      'pointerdown',
      (event) => {
        if (!active.has(record) || event.button !== 0 || event.isPrimary === false) return;
        if (phase === 'closing' && native) motion.openDialog(surface);
        spring.stop();
        phase = 'dragging';
        completion = null;
        gesture = {
          id: event.pointerId,
          start: event.clientY,
          offset: position * height,
          last: event.clientY,
          time: performance.now(),
          velocity: 0,
          moved: false,
        };
        try {
          handle.setPointerCapture(event.pointerId);
        } catch {}
        handle.focus({ preventScroll: true });
        event.preventDefault();
      },
      { signal },
    );
    handle.addEventListener(
      'pointermove',
      (event) => {
        if (!gesture || event.pointerId !== gesture.id) return;
        const now = performance.now(),
          dy = event.clientY - gesture.last;
        const elapsed = Math.max(1, now - gesture.time);
        gesture.velocity =
          gesture.velocity * 0.35 + clamp((dy / elapsed) * 1000, -3000, 3000) * 0.65;
        gesture.time = now;
        gesture.last = event.clientY;
        gesture.moved ||= Math.abs(event.clientY - gesture.start) > 6;
        let pixels = gesture.offset + event.clientY - gesture.start;
        if (pixels < 0) pixels *= 0.2;
        if (pixels > height) pixels = height + (pixels - height) * 0.15;
        spring.jump(pixels / height);
        event.preventDefault();
      },
      { signal },
    );
    handle.addEventListener(
      'pointerup',
      (event) => {
        if (gesture?.id === event.pointerId) finishGesture(false);
      },
      { signal },
    );
    handle.addEventListener(
      'pointercancel',
      (event) => {
        if (gesture?.id === event.pointerId) finishGesture(true);
      },
      { signal },
    );
    handle.addEventListener(
      'lostpointercapture',
      (event) => {
        if (gesture?.id === event.pointerId) finishGesture(true);
      },
      { signal },
    );
    handle.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        if (event.detail && performance.now() < suppressUntil) return;
        if (!active.has(record)) return;
        if (!peek) dismiss();
        else moveTo(target === 0 ? peek : 0);
      },
      { signal },
    );
    handle.addEventListener(
      'keydown',
      (event) => {
        if (!active.has(record) || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
          return;
        event.preventDefault();
        if (event.key === 'ArrowUp' || event.key === 'Home') moveTo(0);
        else if (peek) moveTo(peek);
      },
      { signal },
    );
    surface.addEventListener(
      'close',
      () => {
        if (!surface.open) record.reset();
      },
      { signal },
    );
    return record;
  }

  function refreshViewport() {
    viewportFrame = 0;
    if (!doc?.documentElement) return;
    const viewport = env.visualViewport;
    const root = doc.documentElement;
    const editing = !!doc.activeElement?.matches(
      'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),textarea,[contenteditable=true]',
    );
    // Pinch zoom scales visual geometry without changing layout viewport units.
    // Keep the last keyboard layout until blur or recovery to the keyboard-free height.
    if (viewport?.scale && Math.abs(viewport.scale - 1) > 0.01) {
      const keyboardRecovered =
        baselineHeight > 0 && viewportHeight() * viewport.scale >= baselineHeight * 0.78;
      if (!editing || keyboardRecovered) {
        root.removeAttribute('data-ci-keyboard');
        root.style.removeProperty('--ci-vp-height');
        root.style.removeProperty('--ci-vp-bottom');
      }
      return;
    }
    const height = viewportHeight(),
      top = viewport?.offsetTop || 0;
    if (!editing || !baselineHeight) baselineHeight = Math.max(height, env.innerHeight || 0);
    const resized =
      Math.abs(height - lastViewportHeight) > 1 || env.innerWidth !== lastViewportWidth;
    lastViewportHeight = height;
    lastViewportWidth = env.innerWidth;
    root.style.setProperty('--ci-vp-height', height + 'px');
    root.style.setProperty(
      '--ci-vp-bottom',
      Math.max(0, (env.innerHeight || height) - height - top) + 'px',
    );
    root.toggleAttribute('data-ci-keyboard', editing && height < baselineHeight * 0.78);
    for (const record of active) record.refresh(resized);
  }
  function queueViewport() {
    if (!viewportFrame && env.requestAnimationFrame)
      viewportFrame = env.requestAnimationFrame(refreshViewport);
  }
  function cancelAll() {
    for (const record of [...active]) {
      record.closeImmediately();
    }
    if (viewportFrame) env.cancelAnimationFrame(viewportFrame);
    viewportFrame = 0;
  }
  env.addEventListener?.('resize', queueViewport, { passive: true });
  env.visualViewport?.addEventListener('resize', queueViewport, { passive: true });
  env.visualViewport?.addEventListener('scroll', queueViewport, { passive: true });
  env.screen?.orientation?.addEventListener('change', () => {
    baselineHeight = 0;
    queueViewport();
  });
  doc?.addEventListener('focusin', queueViewport);
  doc?.addEventListener('focusout', queueViewport);
  doc?.addEventListener('visibilitychange', () => {
    if (doc.hidden) for (const record of active) record.cancelGesture();
  });
  env.addEventListener?.('pagehide', cancelAll);
  env.addEventListener?.('pageshow', queueViewport);
  env.CloudInkMobile = Object.freeze({
    attach,
    snapTarget,
    cancelAll,
    openDialog(surface) {
      if (!surface.hasAttribute('data-sheet')) return false;
      return attach(surface).open();
    },
    closeDialog(surface, done) {
      return records.get(surface)?.close(done) || false;
    },
    stats: () => ({
      active: active.size,
      viewportPending: !!viewportFrame || [...active].some((record) => record.resizePending),
    }),
  });
  if (doc) refreshViewport();
})();
