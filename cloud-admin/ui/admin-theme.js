(() => {
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  let choice;
  try {
    choice = localStorage.getItem('theme');
  } catch {}
  function apply() {
    const dark = choice === 'dark' || (choice !== 'light' && system.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.textContent = dark ? '浅色模式' : '深色模式';
      button.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式');
    });
    document.dispatchEvent(new Event('cloudink:theme'));
  }
  apply();
  document.addEventListener('DOMContentLoaded', apply);
  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-theme-toggle]')) return;
    choice = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem('theme', choice);
    } catch {}
    apply();
  });
  system.addEventListener('change', apply);
  window.addEventListener('storage', (event) => {
    if (event.key === 'theme' || event.key === null) {
      choice = event.newValue;
      apply();
    }
  });
})();
