import { $ } from './dom.js';
import { extractMarkdownHeadings, mapScrollBetweenAnchors } from './admin-text-utils.js';

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

export function configureEditorEnhancements({ changed, setZen }) {
  const textarea = $('body');
  if (!textarea) return;

  // Use browser-native insertText/delete commands so toolbar and keyboard edits
  // participate seamlessly in Ctrl+Z / Ctrl+Shift+Z undo/redo history.
  function replaceSelectionUndoable(text, start, end, { mode = 'cursor', cursorPos } = {}) {
    const scrollTop = textarea.scrollTop;
    const expected = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(start, end);
    let applied = false;
    try {
      if (typeof document.execCommand === 'function') {
        applied =
          text === '' && end > start
            ? document.execCommand('delete', false)
            : document.execCommand('insertText', false, text);
      }
    } catch {
      applied = false;
    }
    if (!applied || textarea.value !== expected) {
      textarea.setRangeText(text, start, end, 'end');
      changed();
    }
    if (mode === 'select') {
      textarea.setSelectionRange(start, start + text.length);
    } else if (typeof cursorPos === 'number') {
      textarea.setSelectionRange(cursorPos, cursorPos);
    } else {
      const next = start + text.length;
      textarea.setSelectionRange(next, next);
    }
    textarea.scrollTop = scrollTop;
  }

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
        replaceSelectionUndoable(newLine, lineStart, fullLineEnd, { mode: 'select' });
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
      replaceSelectionUndoable(replacement, start, end, { mode: 'cursor', cursorPos: newCursor });
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
        replaceSelectionUndoable('  ', start, end, { cursorPos: start + 2 });
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
        replaceSelectionUndoable(nextText, lineStart, rangeEnd, { mode: 'select' });
      }
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
          replaceSelectionUndoable('', lineStart, start, { cursorPos: lineStart });
        else {
          const insertion = '\n' + ulMatch[1] + ulMatch[2];
          replaceSelectionUndoable(insertion, start, end, { cursorPos: start + insertion.length });
        }
        return;
      }
      if (olMatch) {
        e.preventDefault();
        if (currentLine.trim() === olMatch[2] + '.')
          replaceSelectionUndoable('', lineStart, start, { cursorPos: lineStart });
        else {
          const insertion = '\n' + olMatch[1] + (parseInt(olMatch[2], 10) + 1) + '. ';
          replaceSelectionUndoable(insertion, start, end, { cursorPos: start + insertion.length });
        }
        return;
      }
    }

    if (start !== end && AUTO_WRAP_PAIRS[e.key]) {
      e.preventDefault();
      const selected = text.slice(start, end);
      replaceSelectionUndoable(`${e.key}${selected}${AUTO_WRAP_PAIRS[e.key]}`, start, end, {
        mode: 'select',
      });
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
      }
    }

    if (e.key === 'Escape' && $('app-view')?.classList.contains('zen-mode')) setZen(false);
  });

  // Bidirectional heading-anchor scroll sync between Markdown editor and preview iframe.
  let mirrorEl = null;
  let cachedMirrorKey = '';
  let cachedEditorAnchors = [];

  function ensureMirror() {
    if (mirrorEl) return mirrorEl;
    mirrorEl = document.createElement('div');
    mirrorEl.setAttribute('aria-hidden', 'true');
    mirrorEl.style.cssText =
      'position:fixed;top:-99999px;left:-99999px;visibility:hidden;pointer-events:none;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;box-sizing:border-box;';
    document.body.append(mirrorEl);
    return mirrorEl;
  }

  function getEditorHeadingAnchors() {
    const value = textarea.value;
    const width = textarea.clientWidth;
    const cacheKey = `${width}:${value.length}:${value}`;
    if (cacheKey === cachedMirrorKey) return cachedEditorAnchors;

    const headings = extractMarkdownHeadings(value);
    if (!headings.length) {
      cachedMirrorKey = cacheKey;
      cachedEditorAnchors = [];
      return cachedEditorAnchors;
    }

    const style = getComputedStyle(textarea);
    const mirror = ensureMirror();
    mirror.style.width = `${width}px`;
    mirror.style.fontFamily = style.fontFamily;
    mirror.style.fontSize = style.fontSize;
    mirror.style.fontWeight = style.fontWeight;
    mirror.style.lineHeight = style.lineHeight;
    mirror.style.letterSpacing = style.letterSpacing;
    mirror.style.wordSpacing = style.wordSpacing;
    mirror.style.tabSize = style.tabSize;
    mirror.style.paddingTop = style.paddingTop;
    mirror.style.paddingRight = style.paddingRight;
    mirror.style.paddingBottom = style.paddingBottom;
    mirror.style.paddingLeft = style.paddingLeft;

    const frag = document.createDocumentFragment();
    const markers = [];
    let cursor = 0;
    for (const h of headings) {
      if (h.charOffset > cursor) {
        frag.append(document.createTextNode(value.slice(cursor, h.charOffset)));
      }
      const marker = document.createElement('span');
      marker.textContent = '\u200b';
      markers.push(marker);
      frag.append(marker);
      cursor = h.charOffset;
    }
    if (cursor < value.length) {
      frag.append(document.createTextNode(value.slice(cursor)));
    }
    mirror.replaceChildren(frag);

    const paddingTop = parseFloat(style.paddingTop) || 0;
    cachedEditorAnchors = markers.map((marker) => Math.max(0, marker.offsetTop - paddingTop));
    cachedMirrorKey = cacheKey;
    return cachedEditorAnchors;
  }

  function getPreviewHeadingAnchors(frameDoc, frameWin) {
    const container =
      frameDoc.querySelector('.article-body') ||
      frameDoc.querySelector('.reader-article') ||
      frameDoc.body;
    if (!container) return [];
    const elements = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    const scrollY = frameWin.scrollY || frameDoc.documentElement.scrollTop || 0;
    return elements.map((el) => Math.max(0, el.getBoundingClientRect().top + scrollY));
  }

  let activeSyncSource = null;
  let syncUnlockTimer = null;
  function lockSync(source) {
    activeSyncSource = source;
    clearTimeout(syncUnlockTimer);
    syncUnlockTimer = setTimeout(() => {
      activeSyncSource = null;
    }, 60);
  }

  function syncEditorToPreview() {
    if (activeSyncSource === 'preview') return;
    const frame = $('preview-frame');
    const frameWin = frame?.contentWindow;
    const frameDoc = frame?.contentDocument;
    if (!frameWin || !frameDoc) return;
    attachPreviewScrollListener();
    const editorMax = textarea.scrollHeight - textarea.clientHeight;
    const frameMax = frameDoc.documentElement.scrollHeight - frameWin.innerHeight;
    if (editorMax <= 0 || frameMax <= 0) return;

    const editorAnchors = getEditorHeadingAnchors();
    const previewAnchors = getPreviewHeadingAnchors(frameDoc, frameWin);
    const targetTop = mapScrollBetweenAnchors(
      textarea.scrollTop,
      editorAnchors,
      previewAnchors,
      editorMax,
      frameMax,
    );
    lockSync('editor');
    frameWin.scrollTo({ top: targetTop, behavior: 'auto' });
  }

  function syncPreviewToEditor() {
    if (activeSyncSource === 'editor') return;
    const frame = $('preview-frame');
    const frameWin = frame?.contentWindow;
    const frameDoc = frame?.contentDocument;
    if (!frameWin || !frameDoc) return;
    const editorMax = textarea.scrollHeight - textarea.clientHeight;
    const frameMax = frameDoc.documentElement.scrollHeight - frameWin.innerHeight;
    if (editorMax <= 0 || frameMax <= 0) return;

    const frameScrollY = frameWin.scrollY || frameDoc.documentElement.scrollTop || 0;
    const editorAnchors = getEditorHeadingAnchors();
    const previewAnchors = getPreviewHeadingAnchors(frameDoc, frameWin);
    const targetTop = mapScrollBetweenAnchors(
      frameScrollY,
      previewAnchors,
      editorAnchors,
      frameMax,
      editorMax,
    );
    lockSync('preview');
    textarea.scrollTop = targetTop;
  }

  let boundPreviewDoc = null;
  function attachPreviewScrollListener() {
    const frame = $('preview-frame');
    const frameWin = frame?.contentWindow;
    const frameDoc = frame?.contentDocument;
    if (!frameWin || !frameDoc || frameDoc === boundPreviewDoc) return;
    boundPreviewDoc = frameDoc;
    frameWin.addEventListener('scroll', syncPreviewToEditor, { passive: true });
    frameDoc.addEventListener('scroll', syncPreviewToEditor, { passive: true });
  }

  textarea.addEventListener('scroll', syncEditorToPreview, { passive: true });
  $('preview-frame')?.addEventListener('load', attachPreviewScrollListener);
  attachPreviewScrollListener();

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
