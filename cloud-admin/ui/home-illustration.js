const $ = (id) => document.getElementById(id);

export function configureHomeIllustration({ api, notice }) {
  const field = $('home-illustration-value');
  const mode = $('home-illustration-mode');
  const choices = $('home-illustration-choices');
  const preview = $('home-illustration-preview');
  const status = $('home-illustration-status');
  let selected = '',
    generation = 0,
    pending = Promise.resolve(),
    cursor = null;
  function show() {
    field.value = mode.value === 'default' ? 'default' : mode.value === 'off' ? '' : selected;
    $('home-illustration-custom').hidden = mode.value !== 'custom';
    preview.hidden = !field.value;
    if (field.value)
      preview.src =
        field.value === 'default' ? '/editorial-botanical.webp' : '/images/' + field.value;
    status.textContent =
      mode.value === 'custom' && !selected
        ? '请先选择或上传插画，再保存。'
        : '保存后点击发布，将更新公开首页。';
  }
  function load(site) {
    generation++;
    selected =
      site?.homeIllustration && site.homeIllustration !== 'default' ? site.homeIllustration : '';
    mode.value = selected ? 'custom' : site?.homeIllustration === 'default' ? 'default' : 'off';
    choices.replaceChildren(new Option('选择图片库中的图片', ''));
    if (selected) choices.add(new Option('当前首页插画', selected));
    choices.value = selected;
    cursor = null;
    pending = Promise.resolve();
    show();
  }
  mode.addEventListener('change', () => {
    generation++;
    show();
  });
  choices.addEventListener('change', () => {
    generation++;
    selected = choices.value;
    show();
  });
  $('home-illustration-library').addEventListener('click', async () => {
    const version = generation;
    const button = $('home-illustration-library');
    button.disabled = true;
    try {
      const data = await api(
        '/api/images' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
      );
      if (version !== generation) return;
      for (const item of data.images) {
        if (
          item.key.endsWith('.ico') ||
          [...choices.options].some((option) => option.value === item.key)
        )
          continue;
        choices.add(new Option(item.name || item.key, item.key));
      }
      cursor = data.cursor;
      button.textContent = cursor ? '加载更多图片' : '刷新图片库';
      choices.value = selected;
      status.textContent = '选择一张图片。普通图片请先在图片库上传，沿用现有压缩能力。';
    } catch (error) {
      if (version === generation) notice(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
  $('home-illustration-upload').addEventListener('click', () =>
    $('home-illustration-file').click(),
  );
  $('home-illustration-file').addEventListener('change', () => {
    const input = $('home-illustration-file'),
      file = input.files[0];
    input.value = '';
    if (!file) return;
    const version = ++generation;
    const button = $('home-illustration-upload');
    button.disabled = true;
    pending = (async () => {
      if (!/\.svg$/i.test(file.name) || !file.size || file.size > 256 * 1024)
        throw new Error('请选择不超过 256 KB 的 SVG 插画。');
      status.textContent = '正在校验并上传 SVG…';
      const result = await api('/api/site-icon', { method: 'POST', body: file, rawBody: true });
      if (version !== generation) return;
      if (!result.key.endsWith('.svg')) throw new Error('请选择有效的 SVG 插画。');
      selected = result.key;
      choices.add(new Option(file.name, selected));
      choices.value = selected;
      mode.value = 'custom';
      show();
    })()
      .catch((error) => {
        if (version === generation) {
          status.textContent = error.message;
          notice(error.message, 'error');
        }
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  preview.addEventListener('error', () => {
    preview.hidden = true;
    status.textContent = '插画无法读取，请检查图片或重新选择。';
  });
  load(null);
  return {
    load,
    async ready() {
      await pending;
      if (mode.value === 'custom' && !selected)
        throw new Error('请先选择首页插画，或切换为默认／关闭。');
    },
  };
}
