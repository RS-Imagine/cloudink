/* Shared blocking theme bootstrap. Palette is author-owned; mode is reader-owned. */
(() => {
  if (window.CloudInkTheme) return;
  const root = document.documentElement;
  const admin = root.hasAttribute('data-cloudink-admin');
  const system = matchMedia('(prefers-color-scheme: dark)');
  const validMode = (value) => (value === 'light' || value === 'dark' ? value : 'auto');
  const validPalette = (value) => (value === 'neutral' ? 'neutral' : 'ink');
  const read = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  let mode = validMode(read('theme'));
  if (admin) root.dataset.palette = validPalette(read('cloudink-admin-palette'));
  else root.dataset.palette = validPalette(root.dataset.palette);
  function apply() {
    const dark = mode === 'dark' || (mode === 'auto' && system.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.themeMode = mode;
    document.querySelectorAll('[data-theme-mode]').forEach((select) => {
      select.value = mode;
    });
    document.querySelectorAll('[data-theme-toggle],#theme-toggle-btn').forEach((button) => {
      const label = dark ? '切换到浅色模式' : '切换到深色模式';
      if (button.hasAttribute('data-theme-toggle') && !button.hasAttribute('data-icon-only'))
        button.textContent = dark ? '浅色模式' : '深色模式';
      button.setAttribute('aria-label', label);
    });
    const light = document.getElementById('hljs-light');
    const night = document.getElementById('hljs-dark');
    if (light && night) {
      light.media = dark ? 'none' : 'all';
      night.media = dark ? 'all' : 'none';
    }
    document.dispatchEvent(new Event('cloudink:theme'));
  }
  function setMode(value) {
    mode = validMode(value);
    try {
      localStorage.setItem('theme', mode);
    } catch {}
    apply();
  }
  function setPalette(value) {
    root.dataset.palette = validPalette(value);
    if (admin) {
      try {
        localStorage.setItem('cloudink-admin-palette', root.dataset.palette);
      } catch {}
    }
    apply();
  }
  window.CloudInkTheme = Object.freeze({ setMode, setPalette });
  apply();
  document.addEventListener('DOMContentLoaded', apply);
  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-theme-toggle],#theme-toggle-btn')) return;
    setMode(root.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  document.addEventListener('change', (event) => {
    if (event.target.matches('[data-theme-mode]')) setMode(event.target.value);
  });
  system.addEventListener('change', apply);
  window.addEventListener('storage', (event) => {
    if (event.key === 'theme' || event.key === null) {
      mode = validMode(read('theme'));
      apply();
    }
    if (admin && (event.key === 'cloudink-admin-palette' || event.key === null)) {
      root.dataset.palette = validPalette(read('cloudink-admin-palette'));
      apply();
    }
  });
})();
