// Responsive presentation only; data navigation still uses the guarded app handlers.
export function mountStudioShell() {
  const disclosures = ['studio-tools', 'post-switcher'].map((id) => document.getElementById(id));
  const dialog = document.getElementById('studio-sheet');
  const narrow = matchMedia('(max-width:759px)');
  let presented = null;
  function restore(focus = true) {
    const current = presented;
    if (!current) return;
    presented = null;
    current.panelAnchor.replaceWith(current.panel);
    current.searchAnchor?.replaceWith(current.search);
    current.node.open = false;
    if (focus && current.trigger.isConnected && !current.trigger.closest('[hidden]'))
      current.trigger.focus({ preventScroll: true });
  }
  const close = (restoreFocus = false) => {
    const opened = disclosures.filter((node) => node.open);
    if (dialog.open) dialog.close();
    restore(restoreFocus);
    for (const node of opened) node.open = false;
    if (restoreFocus && !dialog.open)
      opened.at(-1)?.querySelector('summary').focus({ preventScroll: true });
  };
  function present(node) {
    if (!narrow.matches || typeof dialog.showModal !== 'function' || presented?.node === node)
      return;
    close();
    node.open = true;
    const panel = node.querySelector('.post-list-panel,.studio-tools-panel');
    const panelAnchor = document.createComment('panel position');
    const trigger = node.querySelector('summary');
    panel.before(panelAnchor);
    const isPosts = node.id === 'post-switcher';
    const search = isPosts ? document.getElementById('search') : null;
    const searchAnchor = search ? document.createComment('search position') : null;
    if (search) search.before(searchAnchor);
    presented = { node, panel, panelAnchor, trigger, search, searchAnchor };
    document.getElementById('studio-sheet-title').textContent = isPosts ? '选择文章' : '更多操作';
    dialog.dataset.sheet = isPosts ? 'list' : 'compact';
    if (search) document.getElementById('studio-sheet-search').append(search);
    document.getElementById('studio-sheet-content').append(panel);
    window.CloudInkMotion.openDialog(dialog);
    (
      panel.querySelector('button:not(:disabled)') || document.getElementById('studio-sheet-close')
    ).focus({ preventScroll: true });
  }
  dialog.addEventListener('close', () => {
    if (!dialog.open) restore();
  });
  document
    .getElementById('studio-sheet-close')
    .addEventListener('click', () => window.CloudInkMotion.closeDialog(dialog));
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) window.CloudInkMotion.closeDialog(dialog);
  });
  narrow.addEventListener('change', () => close());
  for (const node of disclosures) {
    node.addEventListener('toggle', () => {
      if (node.open) {
        for (const other of disclosures) if (other !== node) other.open = false;
        present(node);
      }
    });
    node.addEventListener('focusout', (event) => {
      if (presented?.node === node) return;
      if (event.relatedTarget && !node.contains(event.relatedTarget)) node.open = false;
    });
  }
  document.addEventListener('click', (event) => {
    for (const node of disclosures)
      if (
        node.open &&
        !node.contains(event.target) &&
        !(presented?.node === node && dialog.contains(event.target))
      )
        node.open = false;
    const target = event.target.closest('[data-studio-shortcut]');
    if (target) document.getElementById(target.dataset.studioShortcut)?.click();
    if (event.target.closest('.studio-tools-panel button')) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || dialog.open)
      return;
    if (disclosures.some((node) => node.open)) {
      event.preventDefault();
      close(true);
    }
  });
  return { close };
}
