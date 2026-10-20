const $ = (id) => document.getElementById(id);
const iconURL = (key) => /^uploads\/icons\/[a-f0-9]{64}\.(svg|ico)$/.test(key || '')
  ? '/site-icon/' + key.slice('uploads/icons/'.length) : '/favicon.svg';

export function configureSiteIcon({ api, notice }) {
  const input = $('site-icon-file'), field = $('site-icon-value'), preview = $('site-icon-preview');
  let generation = 0, pending = Promise.resolve();
  const show = () => {
    preview.src = iconURL(field.value);
    $('reset-site-icon').disabled = !field.value;
  };
  function load(config) {
    generation++;
    pending = Promise.resolve();
    field.value = config?.siteIcon || '';
    $('site-icon-status').textContent = field.value ? '已选择自定义图标。' : '正在使用 CloudInk 默认图标。';
    show();
  }
  function apply(config) {
    const url = iconURL(config?.siteIcon);
    document.querySelectorAll('.sidebar .brand-mark img, .studio-intro-mark').forEach((image) => { image.src = url; });
    const favicon = document.querySelector('link[rel="icon"]');
    favicon.href = url;
    favicon.type = url.endsWith('.ico') ? 'image/x-icon' : 'image/svg+xml';
  }
  $('upload-site-icon').addEventListener('click', () => input.click());
  $('reset-site-icon').addEventListener('click', () => {
    generation++;
    field.value = '';
    $('site-icon-status').textContent = '已选择默认图标，保存后生效。';
    show();
  });
  input.addEventListener('change', () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const version = ++generation;
    $('upload-site-icon').disabled = true;
    $('reset-site-icon').disabled = true;
    $('site-icon-status').textContent = '正在校验并上传图标…';
    $('site-icon-status').dataset.tone = 'pending';
    const task = (async () => {
      if (!/\.(svg|ico)$/i.test(file.name)) throw new Error('请选择 SVG 或 ICO 文件。');
      if (!file.size || file.size > 256 * 1024) throw new Error('网站图标需为 1 字节至 256 KB。');
      const result = await api('/api/site-icon', { method: 'POST', body: file, rawBody: true });
      if (version !== generation) return;
      field.value = result.key;
      $('site-icon-status').textContent = '图标已上传，保存后应用到后台；发布后更新公开网站。';
      $('site-icon-status').dataset.tone = 'success';
      show();
    })();
    pending = task.catch((error) => {
      if (version !== generation) return;
      $('site-icon-status').textContent = error.message;
      $('site-icon-status').dataset.tone = 'error';
      notice(error.message, 'error');
    }).finally(() => {
      $('upload-site-icon').disabled = false;
      $('reset-site-icon').disabled = !field.value;
    });
  });
  preview.addEventListener('error', () => {
    if (preview.getAttribute('src') !== '/favicon.svg') {
      preview.src = '/favicon.svg';
      $('site-icon-status').textContent = '自定义图标暂时无法读取，请重新上传或恢复默认。';
      $('site-icon-status').dataset.tone = 'error';
    }
  });
  load(null);
  return { load, apply, ready: () => pending };
}
