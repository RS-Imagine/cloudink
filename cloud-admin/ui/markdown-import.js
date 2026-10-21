const $ = (id) => document.getElementById(id);

export function configureMarkdownImport({
  api,
  engineTask,
  flush,
  locked,
  lock,
  saved,
  open,
  notice,
  closeMenu,
}) {
  const input = $('import-files'),
    button = $('import-posts');
  const dialog = $('markdown-import-dialog'),
    list = $('markdown-import-results');
  const status = $('markdown-import-status'),
    close = $('markdown-import-close');
  let busy = false,
    stopped = false,
    trigger = null;
  async function openDraft(slug) {
    const closed = new Promise((resolve) =>
      dialog.addEventListener('close', resolve, { once: true }),
    );
    window.CloudInkMotion.closeDialog(dialog);
    await closed;
    await open(slug);
    $('title').focus({ preventScroll: true });
  }
  function dismiss() {
    if (busy) {
      stopped = true;
      close.disabled = true;
      status.textContent = '正在完成当前文件，随后停止。已经导入的草稿会保留。';
    } else window.CloudInkMotion.closeDialog(dialog);
  }
  close.addEventListener('click', dismiss);
  dialog.addEventListener(
    'cancel',
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss();
    },
    true,
  );
  dialog.addEventListener('close', () => {
    if (busy) stopped = true;
    if (trigger?.isConnected && !trigger.closest('[hidden]'))
      trigger.focus({ preventScroll: true });
  });
  button.addEventListener('click', () => {
    if (busy || locked()) return notice('正在处理当前文章，请稍等。');
    input.click();
  });
  input.addEventListener('change', async () => {
    const files = Array.from(input.files);
    input.value = '';
    if (!files.length) return;
    if (busy || locked()) return notice('正在处理当前文章，请稍等。');
    if (files.length > 100) return notice('一次最多导入 100 个文件，请分批选择。', 'error');
    trigger = $('studio-tools').querySelector('summary');
    closeMenu();
    busy = true;
    stopped = false;
    button.disabled = true;
    lock(true);
    list.replaceChildren();
    close.disabled = false;
    close.textContent = '取消后续导入';
    list.setAttribute('aria-busy', 'true');
    window.CloudInkMotion.openDialog(dialog);
    const today = new Date();
    const date = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-');
    let count = 0,
      failed = 0,
      skipped = 0,
      single = null;
    const summary = () =>
      '已导入 ' + count + ' 篇草稿，失败 ' + failed + ' 个，跳过 ' + skipped + ' 个。';
    const items = files.map((file) => {
      const row = document.createElement('li'),
        name = document.createElement('strong'),
        message = document.createElement('span');
      name.textContent = file.name;
      message.textContent = '等待导入';
      row.append(name, message);
      list.append(row);
      return { row, message };
    });
    try {
      // Flush the current editor before any import writes; a conflict keeps it intact.
      await flush();
      for (let index = 0; index < files.length; index++) {
        const file = files[index],
          { row, message } = items[index];
        if (stopped) {
          skipped++;
          message.textContent = '已跳过：导入已取消';
          row.dataset.state = 'skipped';
          continue;
        }
        row.dataset.state = 'pending';
        message.textContent = '正在读取并保存…';
        status.textContent = '正在导入 ' + (index + 1) + ' / ' + files.length + '：' + file.name;
        try {
          if (!/\.(md|markdown)$/i.test(file.name))
            throw new Error('请选择 .md 或 .markdown 文件。');
          if (file.size > 1_000_000) throw new Error('Markdown 文件最多 1 MB。');
          let source;
          try {
            source = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
          } catch {
            throw new Error('无法读取 UTF-8 文本，请将文件另存为 UTF-8 后重试。');
          }
          if (stopped) {
            skipped++;
            message.textContent = '已跳过：导入已取消';
            row.dataset.state = 'skipped';
            continue;
          }
          const slug = 'post-' + date.replaceAll('-', '') + '-' + crypto.randomUUID();
          const draft = await engineTask('import', { source, filename: file.name, date, slug });
          if (stopped) {
            skipped++;
            message.textContent = '已跳过：导入已取消';
            row.dataset.state = 'skipped';
            continue;
          }
          const result = await api('/api/posts/' + slug, {
            method: 'PUT',
            body: { draft, etag: null },
          });
          saved(result.draft, result);
          single = result;
          count++;
          row.dataset.state = 'success';
          message.textContent = '已保存为新草稿：' + result.draft.front_matter.title;
          const edit = document.createElement('button');
          edit.type = 'button';
          edit.textContent = '打开草稿';
          edit.disabled = true;
          edit.addEventListener('click', async () => {
            try {
              await openDraft(slug);
            } catch (error) {
              notice(error.message, 'error');
            }
          });
          row.append(edit);
        } catch (error) {
          failed++;
          row.dataset.state = 'error';
          message.textContent = '失败：' + error.message;
        }
      }
      status.textContent = summary() + ' 导入不会自动发布。';
    } catch (error) {
      status.textContent = '尚未开始导入：' + error.message;
      for (const { row, message } of items) {
        row.dataset.state = 'skipped';
        message.textContent = '未导入：请先处理当前文章的保存问题。';
      }
    } finally {
      busy = false;
      lock(false);
      button.disabled = false;
      close.disabled = false;
      close.textContent = '完成';
      list.removeAttribute('aria-busy');
      list.querySelectorAll('button').forEach((node) => {
        node.disabled = false;
      });
    }
    if (files.length === 1 && count === 1 && !stopped) {
      try {
        await openDraft(single.draft.front_matter.slug);
      } catch (error) {
        notice(error.message, 'error');
        return;
      }
      notice('已导入 1 篇原稿，已保存为新草稿。检查后可手动发布。', 'success');
    } else close.focus({ preventScroll: true });
  });
}
