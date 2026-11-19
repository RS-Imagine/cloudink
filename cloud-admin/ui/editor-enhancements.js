import { $ } from './dom.js';

const AUTO_WRAP_PAIRS = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
  '`': '`',
  '*': '*',
  _: '_',
};

export function configureEditorEnhancements({ changed, setZen, saveCurrent, notice }) {
  const textarea = $('body');
  if (!textarea) return;

  function applyFormat(type) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const selected = text.slice(start, end);
    let replacement = '';
    let newCursor = start;

    switch (type) {
      case 'bold':
      case 'italic': {
        const tag = type === 'bold' ? '**' : '*';
        replacement = selected ? `${tag}${selected}${tag}` : `${tag}${tag}`;
        newCursor = selected ? end + tag.length * 2 : start + tag.length;
        break;
      }
      case 'code':
        if (selected.includes('\n')) {
          replacement = `\`\`\`\n${selected || ''}\n\`\`\`\n`;
          newCursor = selected ? end + 8 : start + 4;
        } else {
          replacement = selected ? `\`${selected}\`` : '``';
          newCursor = selected ? end + 2 : start + 1;
        }
        break;
      case 'quote':
      case 'ul': {
        const prefix = type === 'quote' ? '> ' : '- ';
        replacement = selected
          ? selected
              .split('\n')
              .map((line) => prefix + line)
              .join('\n')
          : prefix;
        newCursor = start + replacement.length;
        break;
      }
      case 'ol':
        replacement = selected
          ? selected
              .split('\n')
              .map((line, index) => `${index + 1}. ${line}`)
              .join('\n')
          : '1. ';
        newCursor = start + replacement.length;
        break;
      case 'heading': {
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        const lineEnd = text.indexOf('\n', start);
        const fullLineEnd = lineEnd === -1 ? text.length : lineEnd;
        const currentLine = text.slice(lineStart, fullLineEnd);
        let newLine = currentLine;
        if (currentLine.startsWith('## ')) newLine = '### ' + currentLine.slice(3);
        else if (currentLine.startsWith('### ')) newLine = '#### ' + currentLine.slice(4);
        else if (currentLine.startsWith('#### ')) newLine = currentLine.slice(5);
        else newLine = '## ' + currentLine;
        textarea.setRangeText(newLine, lineStart, fullLineEnd, 'select');
        changed();
        textarea.focus();
        return;
      }
      case 'link':
        replacement = `[${selected || '链接文本'}](https://)`;
        newCursor = selected ? end + 11 : start + 1;
        break;
      case 'zen':
        setZen(!$('app-view').classList.contains('zen-mode'));
        return;
    }

    if (replacement) {
      textarea.setRangeText(replacement, start, end, 'end');
      textarea.setSelectionRange(newCursor, newCursor);
      textarea.focus();
      changed();
    }
  }

  document.querySelectorAll('.editor-format-actions [data-format]').forEach((btn) => {
    btn.addEventListener('click', () => applyFormat(btn.dataset.format));
  });

  textarea.addEventListener('keydown', (e) => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;

    if (e.key === 'Tab') {
      e.preventDefault();
      if (start === end) {
        textarea.setRangeText('  ', start, end, 'end');
      } else {
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        const lineEnd = text.indexOf('\n', end);
        const rangeEnd = lineEnd === -1 ? text.length : lineEnd;
        const lines = text.slice(lineStart, rangeEnd).split('\n');
        const nextText = e.shiftKey
          ? lines
              .map((line) =>
                line.startsWith('  ') ? line.slice(2) : line.startsWith(' ') ? line.slice(1) : line,
              )
              .join('\n')
          : lines.map((line) => '  ' + line).join('\n');
        textarea.setRangeText(nextText, lineStart, rangeEnd, 'select');
      }
      changed();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const currentLine = text.slice(lineStart, start);
      const ulMatch = currentLine.match(/^(\s*)([-*+]\s+)/);
      const olMatch = currentLine.match(/^(\s*)(\d+)\.\s+/);
      if (ulMatch) {
        e.preventDefault();
        if (currentLine.trim() === ulMatch[2].trim())
          textarea.setRangeText('', lineStart, start, 'end');
        else textarea.setRangeText('\n' + ulMatch[1] + ulMatch[2], start, end, 'end');
        changed();
        return;
      }
      if (olMatch) {
        e.preventDefault();
        if (currentLine.trim() === olMatch[2] + '.')
          textarea.setRangeText('', lineStart, start, 'end');
        else
          textarea.setRangeText(
            '\n' + olMatch[1] + (parseInt(olMatch[2], 10) + 1) + '. ',
            start,
            end,
            'end',
          );
        changed();
        return;
      }
    }

    if (start !== end && AUTO_WRAP_PAIRS[e.key]) {
      e.preventDefault();
      const selected = text.slice(start, end);
      textarea.setRangeText(`${e.key}${selected}${AUTO_WRAP_PAIRS[e.key]}`, start, end, 'select');
      changed();
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      const key = e.key.toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        applyFormat('bold');
      } else if (key === 'i') {
        e.preventDefault();
        applyFormat('italic');
      } else if (key === 'k') {
        e.preventDefault();
        applyFormat('link');
      } else if (key === 's') {
        e.preventDefault();
        saveCurrent()
          .then(() => notice('草稿已保存。', 'success'))
          .catch((err) => notice(err.message, 'error'));
      }
    }

    if (e.key === 'Escape' && $('app-view')?.classList.contains('zen-mode')) setZen(false);
  });

  let scrollSyncing = false;
  textarea.addEventListener(
    'scroll',
    () => {
      if (scrollSyncing) return;
      const scrollable = textarea.scrollHeight - textarea.clientHeight;
      if (scrollable <= 0) return;
      const progress = textarea.scrollTop / scrollable;
      const frame = $('preview-frame');
      const frameWin = frame?.contentWindow;
      const frameDoc = frame?.contentDocument;
      if (!frameWin || !frameDoc) return;
      const frameScrollable = frameDoc.documentElement.scrollHeight - frameWin.innerHeight;
      if (frameScrollable > 0) {
        scrollSyncing = true;
        frameWin.scrollTo({ top: progress * frameScrollable, behavior: 'auto' });
        requestAnimationFrame(() => {
          scrollSyncing = false;
        });
      }
    },
    { passive: true },
  );

  const splitter = $('editor-splitter');
  const panes = $('editor-panes');
  if (splitter && panes) {
    const setSplit = (pct) => {
      const percent = parseFloat(pct);
      panes.style.setProperty('--editor-split-left', `${percent}%`);
      panes.style.setProperty('--editor-split-right', `${100 - percent}%`);
      panes.style.setProperty('--editor-split-percent', `${percent}%`);
    };
    try {
      const savedPercent = localStorage.getItem('cloudink-split-percent');
      if (savedPercent) setSplit(savedPercent);
    } catch {}

    let dragging = false;
    splitter.addEventListener('pointerdown', (e) => {
      dragging = true;
      splitter.classList.add('is-dragging');
      splitter.setPointerCapture(e.pointerId);
    });
    splitter.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = panes.getBoundingClientRect();
      const percent = Math.min(80, Math.max(20, ((e.clientX - rect.left) / rect.width) * 100));
      setSplit(percent);
    });
    const stopDrag = () => {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove('is-dragging');
      try {
        localStorage.setItem(
          'cloudink-split-percent',
          panes.style.getPropertyValue('--editor-split-percent'),
        );
      } catch {}
    };
    splitter.addEventListener('pointerup', stopDrag);
    splitter.addEventListener('pointercancel', stopDrag);
  }
}
