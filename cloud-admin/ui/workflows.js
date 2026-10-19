// View and feedback helpers only. Saving, publishing and storage stay in their existing handlers.
const $ = (id) => document.getElementById(id);
export function feedback(id, message, tone = 'neutral') {
  if (!id) return;
  const node = $(id);
  if (!node) return;
  if (message !== undefined) node.textContent = message;
  node.dataset.tone = tone;
  node.hidden = !node.textContent;
}
const confirmation = $('confirmation-dialog');
confirmation.querySelector('form').addEventListener('submit', (event) => {
  event.preventDefault();
  confirmation.returnValue = event.submitter?.value || 'cancel';
  window.CloudInkMotion.closeDialog(confirmation);
});
export function confirmAction(
  message,
  { title = '继续操作？', accept = '继续', danger = false } = {},
) {
  if (!confirmation.showModal) return Promise.resolve(window.confirm(message));
  if (confirmation.open) return Promise.resolve(false);
  const trigger = document.activeElement;
  $('confirmation-title').textContent = title;
  $('confirmation-message').textContent = message;
  $('confirmation-accept').textContent = accept;
  $('confirmation-accept').classList.toggle('destructive', danger);
  confirmation.returnValue = '';
  return new Promise((resolve) => {
    confirmation.addEventListener(
      'close',
      () => {
        if (trigger?.isConnected && !trigger.closest('[hidden]'))
          trigger.focus({ preventScroll: true });
        resolve(confirmation.returnValue === 'confirm');
      },
      { once: true },
    );
    window.CloudInkMotion.openDialog(confirmation);
    $('confirmation-cancel').focus({ preventScroll: true });
  });
}
export function mountEditorPanes({ preview, invalidate }) {
  const wide = matchMedia('(min-width:1100px)');
  let preferred = 'split';
  $('editor-panes').dataset.ciPanes = '';
  $('show-split').dataset.ciPaneControl = '';
  function render() {
    const focused = document.activeElement;
    const mode = wide.matches ? preferred : preferred === 'preview' ? 'preview' : 'writing';
    for (const name of ['writing', 'split', 'preview']) {
      $('show-' + name).setAttribute('aria-pressed', String(name === mode));
      $('show-' + name).classList.toggle('active', name === mode);
    }
    if (
      (focused === $('preview-frame') && mode === 'writing') ||
      (focused === $('body') && mode === 'preview') ||
      (focused === $('show-split') && !wide.matches)
    )
      $('show-' + mode).focus({ preventScroll: true });
    $('editor-panes').classList.toggle('preview-only', mode === 'preview');
    $('editor-panes').classList.toggle('writing-only', mode === 'writing');
    $('show-split').hidden = !wide.matches;
    if (mode === 'writing') invalidate();
    else preview();
  }
  for (const mode of ['writing', 'split', 'preview'])
    $('show-' + mode).addEventListener('click', () => {
      preferred = mode;
      render();
    });
  wide.addEventListener('change', render);
  render();
}
