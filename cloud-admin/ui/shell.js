// Responsive presentation only; data navigation still uses the guarded app handlers.
export function mountStudioShell() {
  const disclosures = ['studio-tools'].map((id) => document.getElementById(id));
  const dialog = document.getElementById('studio-sheet');
  const narrow = matchMedia('(max-width:767px)');
  const siteLink = document.getElementById('site-link');
  const siteHome = document.createComment('public site link');
  siteLink.before(siteHome);
  function placeSiteLink() {
    if (narrow.matches)
      document.querySelector('#studio-tools .studio-tools-panel').append(siteLink);
    else siteHome.after(siteLink);
  }
  placeSiteLink();
  const compact = matchMedia('(max-width:1149px)');
  const metadata = document.querySelector('.post-details');
  const metadataDialog = document.getElementById('editor-info-dialog');
  const information = document.getElementById('editor-information');
  const metadataHome = document.createComment('article information');
  information.before(metadataHome);
  const maintenance = document.getElementById('publishing-summary');
  function placeMaintenance() {
    const view = document.getElementById('app-view').dataset.view;
    maintenance.hidden = !['home', 'posts', 'settings'].includes(view);
    document
      .getElementById(view === 'settings' ? 'settings-maintenance-slot' : 'manage-maintenance-slot')
      .append(maintenance);
  }
  function restoreMetadata() {
    metadataHome.after(information);
    metadata.open = true;
  }
  document.getElementById('editor-info-toggle').addEventListener('click', () => {
    if (!compact.matches) return;
    document.getElementById('editor-info-content').append(information);
    metadata.open = true;
    window.CloudInkMotion.openDialog(metadataDialog);
  });
  document
    .getElementById('editor-info-close')
    .addEventListener('click', () => window.CloudInkMotion.closeDialog(metadataDialog));
  metadataDialog.addEventListener('close', () => {
    restoreMetadata();
    if (!document.getElementById('editor-view').hidden)
      document.getElementById('editor-info-toggle').focus({ preventScroll: true });
  });
  compact.addEventListener('change', () => {
    if (metadataDialog.open) metadataDialog.close();
    restoreMetadata();
  });
  let presented = null;
  function restore(focus = true) {
    const current = presented;
    if (!current) return;
    presented = null;
    current.panelAnchor.replaceWith(current.panel);
    if (current.node) current.node.open = false;
    if (focus && current.trigger.isConnected && !current.trigger.closest('[hidden]'))
      current.trigger.focus({ preventScroll: true });
  }
  const close = (restoreFocus = false) => {
    if (metadataDialog.open) metadataDialog.close();
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
    const panel = node.querySelector('.studio-tools-panel');
    const panelAnchor = document.createComment('panel position');
    const trigger = node.querySelector('summary');
    panel.before(panelAnchor);
    presented = { node, panel, panelAnchor, trigger };
    document.getElementById('studio-sheet-title').textContent = '更多操作';
    dialog.dataset.sheet = 'compact';
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
  narrow.addEventListener('change', () => {
    close();
    placeSiteLink();
  });
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
  return { close, placeMaintenance };
}
