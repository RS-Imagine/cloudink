const $ = (id) => document.getElementById(id);
export function configureImages(options) {
  let library;
  function ready() {
    library ||= import('/image-library.js')
      .then(({ configureImages }) => configureImages(options))
      .catch(() => {
        library = null;
        throw new Error('图片库工具加载失败，请检查网络并刷新后台后重试。');
      });
    return library;
  }
  for (const id of ['images', 'choose-library-image'])
    $(id).addEventListener('click', () =>
      options.action(id, '正在打开…', async () => {
        const current = options.beginNavigation();
        const tools = await ready();
        if (current()) await tools.show(current);
      }),
    );
}
