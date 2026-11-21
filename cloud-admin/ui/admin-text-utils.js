// Pure text & scroll-mapping helpers shared across admin UI modules.

/**
 * Truncate a long filename in the middle while preserving the tail suffix
 * (extension and size/variant suffixes such as -180.png, -192.png, -512.png, -512-maskable.png).
 */
export function formatMiddleEllipsis(name, { maxLength = 28, tailLength = 16 } = {}) {
  const value = String(name || '');
  if (value.length <= maxLength) return value;
  const suffixMatch = value.match(/(?:-[A-Za-z0-9]+)*\.[A-Za-z0-9]{1,8}$/);
  const suffixLen = suffixMatch ? suffixMatch[0].length : 0;
  const maxTail = Math.max(6, maxLength - 5);
  const keepTail = Math.min(maxTail, Math.max(tailLength, suffixLen));
  const keepHead = Math.max(3, maxLength - keepTail - 1);
  if (keepHead + keepTail + 1 >= value.length) return value;
  return `${value.slice(0, keepHead)}…${value.slice(value.length - keepTail)}`;
}

/**
 * Strip Markdown syntax from a short note into clean plain text for list previews.
 * Images are removed completely (the card displays a separate "含图片" badge).
 */
export function markdownToShortPreview(markdown) {
  const input = String(markdown || '').replace(/\r\n?/g, '\n');
  if (!input.trim()) return '';

  // 1. Replace fenced code blocks with a single-line placeholder.
  let text = input.replace(
    /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g,
    '$1代码片段',
  );

  // 2. Remove HTML <img> tags and Markdown images completely.
  text = text.replace(/<img\b[^>]*>/gi, '');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/!\[[^\]]*\]\[[^\]]*\]/g, '');

  // 3. Remove reference-style link definitions.
  text = text.replace(/^[ \t]*\[[^\]]+\]:[ \t]+\S+.*$/gm, '');

  // 4. Convert Markdown links to their visible label text.
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  text = text.replace(/<(https?:\/\/[^>\s]+)>/gi, '$1');

  // 5. Strip inline code backticks while preserving code text.
  text = text.replace(/`+([^`\n]+?)`+/g, '$1');

  // 6. Strip horizontal rules and per-line block markers (headings, quotes, lists).
  text = text
    .split('\n')
    .map((line) => {
      if (/^[ \t]*(?:[-*_][ \t]*){3,}$/.test(line)) return '';
      let out = line;
      out = out.replace(/^[ \t]*(?:>[ \t]*)+/, '');
      out = out.replace(/^[ \t]*#{1,6}[ \t]+/, '');
      out = out.replace(/[ \t]+#+[ \t]*$/, '');
      out = out.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, '');
      return out;
    })
    .join('\n');

  // 7. Strip inline emphasis / strikethrough markers while preserving inner text.
  text = text.replace(/\*\*\*([^*\n]+?)\*\*\*/g, '$1');
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, '$1');
  text = text.replace(/\*([^*\n]+?)\*/g, '$1');
  text = text.replace(/(^|[^\w])___([^_\n]+?)___(?=$|[^\w])/g, '$1$2');
  text = text.replace(/(^|[^\w])__([^_\n]+?)__(?=$|[^\w])/g, '$1$2');
  text = text.replace(/(^|[^\w])_([^_\n]+?)_(?=$|[^\w])/g, '$1$2');
  text = text.replace(/~~([^~\n]+?)~~/g, '$1');

  // 8. Strip any remaining simple HTML tags and Markdown backslash escapes.
  text = text.replace(/<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/gi, '');
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!~>])/g, '$1');

  // 9. Normalize whitespace.
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Format an image library reference label cleanly without redundant prefixes.
 */
export function formatImageReferenceLabel(ref, kindLabels) {
  const kinds = kindLabels || {
    published: '已发布文章',
    pending: '正在发布的版本',
    draft: '草稿',
    settings: '网站设置',
    backup: '备份任务',
  };
  const title = String(ref?.title || '').trim();
  if (ref?.kind === 'settings') {
    if (
      !title ||
      title === '网站设置' ||
      title === '线上网站设置' ||
      title === '网站设置（已发布）'
    ) {
      return '网站设置（已发布）';
    }
    if (title === '待发布网站设置' || title === '网站设置（待发布）') {
      return '网站设置（待发布）';
    }
    if (title.startsWith('网站设置')) return title;
    return `${kinds.settings} · ${title}`;
  }
  const prefix = kinds[ref?.kind] || ref?.kind || '';
  return prefix ? `${prefix} · ${title}` : title;
}

/**
 * Extract ATX headings from Markdown source, ignoring fenced code blocks.
 * Returns heading descriptors with character offset and 0-based line index.
 */
export function extractMarkdownHeadings(markdown) {
  const text = String(markdown || '');
  const lines = text.split('\n');
  const headings = [];
  let offset = 0;
  let fence = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const fenceMatch = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = { char: marker[0], len: marker.length };
      } else if (
        marker[0] === fence.char &&
        marker.length >= fence.len &&
        /^[ \t]*[`~]+[ \t]*$/.test(line)
      ) {
        fence = null;
      }
    } else if (!fence) {
      const headingMatch = line.match(/^[ \t]{0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/);
      if (headingMatch) {
        headings.push({
          level: headingMatch[1].length,
          text: headingMatch[2].trim(),
          lineIndex: i,
          charOffset: offset,
        });
      }
    }
    offset += raw.length + 1;
  }
  return headings;
}

/**
 * Map a scroll position from source pane coordinates to target pane coordinates
 * using paired monotonically increasing anchor stops, with linear interpolation
 * between surrounding anchors and proportional fallback when no anchors exist.
 */
export function mapScrollBetweenAnchors(
  scrollPos,
  sourceAnchors,
  targetAnchors,
  sourceMax,
  targetMax,
) {
  if (!(sourceMax > 0) || !(targetMax > 0)) return 0;
  const clamped = Math.max(0, Math.min(sourceMax, scrollPos));

  const pairCount = Math.min(sourceAnchors.length, targetAnchors.length);
  const src = [0];
  const dst = [0];
  for (let i = 0; i < pairCount; i++) {
    const s = Math.max(0, Math.min(sourceMax, Number(sourceAnchors[i]) || 0));
    const t = Math.max(0, Math.min(targetMax, Number(targetAnchors[i]) || 0));
    if (s > src[src.length - 1] && t >= dst[dst.length - 1]) {
      src.push(s);
      dst.push(t);
    }
  }
  if (src[src.length - 1] < sourceMax) {
    src.push(sourceMax);
    dst.push(targetMax);
  } else {
    dst[dst.length - 1] = targetMax;
  }

  for (let i = 0; i < src.length - 1; i++) {
    const s0 = src[i];
    const s1 = src[i + 1];
    if (clamped <= s1 || i === src.length - 2) {
      const span = s1 - s0;
      const ratio = span > 0 ? (clamped - s0) / span : 0;
      const t0 = dst[i];
      const t1 = dst[i + 1];
      return Math.max(0, Math.min(targetMax, t0 + ratio * (t1 - t0)));
    }
  }
  return (clamped / sourceMax) * targetMax;
}
