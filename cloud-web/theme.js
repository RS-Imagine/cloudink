(() => {
  let stored;
  try { stored = localStorage.getItem('theme'); } catch { /* Browser storage may be disabled. */ }
  const theme = stored === 'dark' || stored === 'light' ? stored : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  const light = document.getElementById('hljs-light'), dark = document.getElementById('hljs-dark');
  if (light && dark) { light.media = theme === 'dark' ? 'none' : 'all'; dark.media = theme === 'dark' ? 'all' : 'none'; }
})();
