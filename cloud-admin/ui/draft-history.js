import { $ } from './dom.js';

const SNAPSHOT_PREFIX = 'cloudink-snapshots:';
const SNAPSHOT_MERGE_MS = 30_000;
const SNAPSHOT_LIMIT = 20;

export function saveLocalSnapshot(slug, draft) {
  if (!slug || !draft) return;
  try {
    const key = SNAPSHOT_PREFIX + slug;
    const raw = localStorage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    const now = Date.now();
    const entry = { time: now, title: draft.front_matter?.title || '', draft };
    if (list.length > 0 && Math.abs(now - list[0].time) < SNAPSHOT_MERGE_MS) {
      list[0] = entry;
    } else {
      list.unshift(entry);
      if (list.length > SNAPSHOT_LIMIT) list.pop();
    }
    localStorage.setItem(key, JSON.stringify(list));
  } catch {}
}

export function openDraftHistory({ getSlug, descriptionField, sizeEditorFields, changed, notice }) {
  const slug = getSlug();
  if (!slug) {
    notice('请先打开或新建一篇文章。', 'info');
    return;
  }
  const dialog = $('draft-history-dialog');
  const listEl = $('draft-history-list');
  listEl.replaceChildren();
  let snapshots = [];
  try {
    snapshots = JSON.parse(localStorage.getItem(SNAPSHOT_PREFIX + slug) || '[]');
  } catch {}
  if (snapshots.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.style.padding = '12px 0';
    empty.textContent = '当前文章暂无历史快照。继续编辑将自动生成。';
    listEl.append(empty);
  } else {
    for (const snap of snapshots) {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border:1px solid var(--line);border-radius:8px;background:var(--paper);gap:12px;';
      const info = document.createElement('div');
      const timeStr = new Date(snap.time).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const chars = (snap.draft?.body_markdown || '').replace(/\s/g, '').length;
      info.innerHTML = `<strong>${timeStr}</strong> <span class="muted" style="font-size:12px;margin-left:8px;">${chars} 字符</span>`;
      const restoreBtn = document.createElement('button');
      restoreBtn.textContent = '恢复此快照';
      restoreBtn.className = 'quiet';
      restoreBtn.style.fontSize = '12px';
      restoreBtn.addEventListener('click', () => {
        if (confirm('确定恢复到该历史快照吗？当前编辑框内容将被替换。')) {
          $('body').value = snap.draft?.body_markdown || '';
          if (snap.draft?.front_matter?.title) $('title').value = snap.draft.front_matter.title;
          if (snap.draft?.front_matter?.description)
            descriptionField.value = snap.draft.front_matter.description;
          sizeEditorFields();
          changed();
          dialog.close();
          notice('已恢复本地快照内容。', 'success');
        }
      });
      row.append(info, restoreBtn);
      listEl.append(row);
    }
  }
  dialog.showModal();
}

export function configureDraftHistory(context) {
  $('draft-history-close')?.addEventListener('click', () => {
    $('draft-history-dialog')?.close();
  });
  return {
    open: () => openDraftHistory(context),
  };
}
