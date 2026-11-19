// Responsive presentation only; data navigation still uses the guarded app handlers.
import { $ } from './dom.js';

export function mountStudioShell() {
  const motion = window.CloudInkMotion;
  const tools = $('studio-tools');
  const toolsToggle = tools.querySelector('summary');
  const dialog = $('studio-sheet');
  const categoryLinks = Array.from(document.querySelectorAll('.settings-nav a'));
  function markSettingsSection() {
    const current = categoryLinks.find((link) => link.hash === location.hash) || categoryLinks[0];
    for (const link of categoryLinks) {
      if (link === current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }
  window.addEventListener('hashchange', markSettingsSection);
  markSettingsSection();
  const narrow = matchMedia('(max-width:767px)');
  const collapsedSidebar = matchMedia('(max-width:1279px)');
  const siteLink = $('site-link');
  const toolsPanel = tools.querySelector('.studio-tools-panel');
  const siteHome = document.createComment('public site link');
  siteLink.before(siteHome);
  function placeSiteLink() {
    if (collapsedSidebar.matches) toolsPanel.append(siteLink);
    else siteHome.after(siteLink);
  }
  placeSiteLink();
  const compact = matchMedia('(max-width:1149px)');
  const metadata = document.querySelector('.post-details');
  const metadataDialog = $('editor-info-dialog');
  const information = $('editor-information');
  const metadataHome = document.createComment('article information');
  information.before(metadataHome);
  const maintenance = $('publishing-summary');
  function placeMaintenance() {
    const view = $('app-view').dataset.view;
    maintenance.hidden = !['home', 'posts', 'settings'].includes(view);
    $(view === 'settings' ? 'settings-maintenance-slot' : 'manage-maintenance-slot').append(
      maintenance,
    );
  }
  function restoreMetadata() {
    metadataHome.after(information);
    metadata.open = true;
  }
  $('editor-info-toggle').addEventListener('click', () => {
    if (!compact.matches) return;
    $('editor-info-content').append(information);
    metadata.open = true;
    motion.openDialog(metadataDialog);
  });
  $('editor-info-close').addEventListener('click', () => motion.closeDialog(metadataDialog));
  metadataDialog.addEventListener('close', () => {
    restoreMetadata();
    if (!$('editor-view').hidden) $('editor-info-toggle').focus({ preventScroll: true });
  });
  compact.addEventListener('change', () => {
    if (metadataDialog.open) metadataDialog.close();
    restoreMetadata();
  });
  let panelHome = null;
  function restore(focus = true) {
    if (!panelHome) return;
    panelHome.replaceWith(toolsPanel);
    panelHome = null;
    tools.open = false;
    if (focus) toolsToggle.focus({ preventScroll: true });
  }
  const close = (restoreFocus = false) => {
    if (metadataDialog.open) metadataDialog.close();
    const opened = tools.open;
    if (dialog.open) dialog.close();
    restore(restoreFocus);
    tools.open = false;
    if (restoreFocus && opened) toolsToggle.focus({ preventScroll: true });
  };
  function present() {
    if (!narrow.matches || typeof dialog.showModal !== 'function' || panelHome) return;
    close();
    tools.open = true;
    panelHome = document.createComment('panel position');
    toolsPanel.before(panelHome);
    $('studio-sheet-content').append(toolsPanel);
    motion.openDialog(dialog);
    toolsPanel.querySelector('button:not(:disabled), a[href]')?.focus({
      preventScroll: true,
    });
  }
  dialog.addEventListener('close', () => {
    if (!dialog.open) restore();
  });
  $('studio-sheet-close').addEventListener('click', () => motion.closeDialog(dialog));
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) motion.closeDialog(dialog);
  });
  narrow.addEventListener('change', () => close());
  collapsedSidebar.addEventListener('change', placeSiteLink);
  tools.addEventListener('toggle', () => {
    if (tools.open) present();
  });
  tools.addEventListener('focusout', (event) => {
    if (!panelHome && event.relatedTarget && !tools.contains(event.relatedTarget))
      tools.open = false;
  });
  document.addEventListener('click', (event) => {
    if (tools.open && !tools.contains(event.target) && !dialog.contains(event.target))
      tools.open = false;
    const target = event.target.closest('[data-studio-shortcut]');
    if (target) $(target.dataset.studioShortcut)?.click();
    if (event.target.closest('.studio-tools-panel button')) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || dialog.open)
      return;
    if (tools.open) {
      event.preventDefault();
      close(true);
    }
  });
  return { close, placeMaintenance };
}
