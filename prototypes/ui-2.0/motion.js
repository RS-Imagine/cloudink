const motion = window.CloudInkMotion;
motion.mount();
const sample = document.getElementById('sample'),
  dialog = document.getElementById('dialog');
let visible = true;
document.getElementById('toggle').onclick = () => {
  visible = !visible;
  if (visible) {
    sample.hidden = false;
    motion.enter(sample);
  } else
    motion.exit(sample, {
      onFinish() {
        sample.hidden = true;
      },
    });
};
document.getElementById('replay').onclick = () => {
  visible = true;
  sample.hidden = false;
  motion.enter(sample);
};
document.getElementById('open').onclick = () => motion.openDialog(dialog);
document.getElementById('close').onclick = () => motion.closeDialog(dialog);
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) motion.closeDialog(dialog);
});
document.getElementById('theme').onclick = () => {
  document.documentElement.dataset.theme =
    document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
};
const preference = matchMedia('(prefers-reduced-motion: reduce)');
function status() {
  document.getElementById('status').textContent = preference.matches
    ? '减少动态效果已启用。'
    : '标准动效已启用。';
}
preference.addEventListener('change', status);
status();
