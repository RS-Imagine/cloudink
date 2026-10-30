const $ = (id) => document.getElementById(id);

function source(draft) {
  const f = draft.front_matter;
  return '+++\n' +
    'title = ' + JSON.stringify(f.title) + '\n' +
    'slug = ' + JSON.stringify(f.slug) + '\n' +
    'date = ' + JSON.stringify(f.date) + '\n' +
    'description = ' + JSON.stringify(f.description) + '\n' +
    'draft = ' + !!f.draft + '\n' +
    (f.updated ? 'updated = ' + JSON.stringify(f.updated) + '\n' : '') +
    (f.aliases?.length ? 'aliases = ' + JSON.stringify(f.aliases) + '\n' : '') +
    '+++\n\n' + draft.body_markdown;
}
export async function postAction(id, context) {
  const state = context.get();
  if (!state) return;
  if (id === 'download-post') {
    const button = $(id);
    button.disabled = true;
    try {
      const url = URL.createObjectURL(new Blob([source(state.draft)], { type: 'text/markdown' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = state.draft.front_matter.slug + '.md';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      context.notice('已开始下载原稿，请查看浏览器下载列表。', 'success');
    } finally {
      button.disabled = false;
    }
    return;
  }
  const dialog = $('post-address-dialog');
  if (dialog.open) return;
  const trigger = document.activeElement;
  const input = $('post-address-input');
  const submit = $('post-address-submit');
  const close = $('post-address-close');
  const status = $('post-address-status');
  const original = state.draft.front_matter.slug;
  const label = state.published ? '修改地址并发布' : '修改草稿地址';
  let busy = false, completed = false, loaded = false, target = original;
  $('post-address-current').textContent = '当前地址：/posts/' + original + '/';
  $('post-address-help').textContent = state.published
    ? '将当前文章内容保存并发布到新地址。旧链接自动跳转，其他草稿不会发布。'
    : '修改后仍是草稿，不会自动发布。正文和图片引用保持不变。';
  input.value = original;
  input.readOnly = false;
  submit.textContent = label;
  submit.disabled = false;
  close.disabled = false;
  close.textContent = '取消';
  status.hidden = true;
  const dismiss = () => {
    if (busy) return;
    if (completed && !loaded) {
      location.reload();
      return;
    }
    window.CloudInkMotion.closeDialog(dialog);
  };
  const cancel = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    dismiss();
  };
  dialog.addEventListener('cancel', cancel, { capture: true });
  close.onclick = dismiss;
  dialog.addEventListener('close', () => {
    dialog.removeEventListener('cancel', cancel, { capture: true });
    $('post-address-form').onsubmit = null;
    close.onclick = null;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }, { once: true });
  $('post-address-form').onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const value = input.value.trim();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(value) || value === original) {
      status.textContent = value === original ? '请输入与当前不同的新地址。' : '请按要求填写新的文章地址。';
      status.dataset.tone = 'error';
      status.hidden = false;
      input.focus();
      return;
    }
    busy = true;
    context.lock(true);
    input.readOnly = true;
    submit.disabled = close.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    submit.textContent = completed ? '正在打开文章…' : '正在修改…';
    status.textContent = state.published ? '正在生成并发布新地址，请稍候…' : '正在保存新地址…';
    status.dataset.tone = 'pending';
    status.hidden = false;
    try {
      if (!completed) {
        if (context.get()?.draft.front_matter.slug !== original)
          throw new Error('文章已切换，请关闭窗口后重新打开改址操作。');
        await context.flush();
        const current = context.get();
        if (!current?.etag) throw new Error('请先填写文章标题并保存草稿。');
        target = value;
        if (state.published)
          await context.publish({ slug: original, etag: current.etag, renameTo: target });
        else
          await context.api('/api/posts/' + encodeURIComponent(original) + '/rename', {
            method: 'POST',
            body: { slug: target, etag: current.etag },
          });
        completed = true;
      }
      await context.replace(target);
      loaded = true;
      context.notice(state.published ? '文章地址已更新，旧链接将自动跳转。' : '草稿地址已更新。', 'success');
      busy = false;
      context.lock(false);
      dismiss();
    } catch (error) {
      status.textContent = completed ? '地址已修改，但暂时无法打开文章。可以重试打开或刷新后台。' : error.message;
      status.dataset.tone = 'error';
      submit.textContent = completed ? '重新打开文章' : label;
      close.textContent = completed ? '刷新后台' : '取消';
    } finally {
      busy = false;
      context.lock(false);
      input.readOnly = completed;
      submit.disabled = close.disabled = false;
      submit.removeAttribute('aria-busy');
    }
  };
  window.CloudInkMotion.openDialog(dialog);
  input.focus();
  input.select();
}
