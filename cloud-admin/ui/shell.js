// UI-only disclosures. Navigation still goes through the existing guarded handlers.
export function mountStudioShell() {
  const disclosures = ['studio-tools', 'post-switcher'].map(id => document.getElementById(id));
  const close = (restoreFocus = false) => {
    const opened = disclosures.filter(node => node.open);
    for (const node of opened) node.open = false;
    if (restoreFocus) opened.at(-1)?.querySelector('summary').focus({ preventScroll: true });
  };
  for (const node of disclosures) {
    node.addEventListener('toggle', () => {
      if (node.open) for (const other of disclosures) if (other !== node) other.open = false;
    });
    node.addEventListener('focusout', () => {
      queueMicrotask(() => {
        if (!node.contains(document.activeElement)) node.open = false;
      });
    });
  }
  document.addEventListener('click', event => {
    for (const node of disclosures) if (node.open && !node.contains(event.target)) node.open = false;
    const target = event.target.closest('[data-studio-shortcut]');
    if (target) document.getElementById(target.dataset.studioShortcut)?.click();
    if (event.target.closest('.studio-tools-panel button')) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    if (disclosures.some(node => node.open)) {
      event.preventDefault();
      close(true);
    }
  });
  return { close };
}
