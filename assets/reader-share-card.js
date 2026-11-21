export async function openShareCard({ showDialog, shareBtn, t }) {
  if (document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch (_) {}
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const palette = getComputedStyle(document.documentElement);
  const readingFont =
    palette.getPropertyValue('--reader-font-family').trim() ||
    palette.getPropertyValue('--ci-font-reading').trim() ||
    "'Iowan Old Style', 'Palatino Linotype', 'Noto Serif', 'Noto Serif SC', 'Songti SC', 'Noto Serif CJK SC', serif";
  const uiFont =
    palette.getPropertyValue('--ci-font-ui').trim() ||
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif";

  const surfaceColor = palette.getPropertyValue('--ci-surface').trim() || '#fbf8f2';
  const primaryColor = palette.getPropertyValue('--ci-primary').trim() || '#784d2b';
  const textColor = palette.getPropertyValue('--ci-text').trim() || '#2c2520';
  const mutedColor = palette.getPropertyValue('--ci-muted').trim() || '#786e65';
  const dividerColor = palette.getPropertyValue('--ci-divider').trim() || '#e8e0d5';

  const nonLeading = /^[，。？！、；：”’）》\?!,.:;]+$/;
  const singleHan = (line) => /^\p{Script=Han}$/u.test(line.replace(/[\p{P}\s]/gu, ''));
  const language = document.documentElement.lang || 'zh-CN';
  const wordSegmenter =
    globalThis.Intl?.Segmenter && new Intl.Segmenter(language, { granularity: 'word' });
  const graphemeSegmenter =
    globalThis.Intl?.Segmenter && new Intl.Segmenter(language, { granularity: 'grapheme' });
  function segment(text, segmenter, fallback) {
    return segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : fallback(text);
  }
  const wordsOf = (text) => segment(text, wordSegmenter, (value) => value.split(/(\s+)/));
  const glyphsOf = (text) => segment(text, graphemeSegmenter, Array.from);
  function getLines(text, font, maxWidth, phrases) {
    ctx.font = font;
    const fits = (line) => ctx.measureText(line).width <= maxWidth;
    const words = phrases
      ? phrases.flatMap((phrase) =>
          fits(phrase)
            ? [phrase]
            : wordsOf(phrase).flatMap((word) => (fits(word) ? [word] : glyphsOf(word))),
        )
      : wordsOf(text);
    const lines = [];
    let currentLine = '';
    for (const word of words) {
      const testLine = currentLine + word;
      if (!fits(testLine) && currentLine.trim()) {
        if (!phrases && nonLeading.test(word)) {
          currentLine = testLine;
        } else {
          const tail =
            phrases && nonLeading.test(word) ? glyphsOf(currentLine.trimEnd()).at(-1) : '';
          if (tail && currentLine.trimEnd().length > tail.length && fits(tail + word)) {
            lines.push(currentLine.trimEnd().slice(0, -tail.length));
            currentLine = tail + word;
          } else {
            lines.push(currentLine.trimEnd());
            currentLine = word.trimStart();
          }
        }
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine.trim()) lines.push(currentLine.trimEnd());
    if (phrases) {
      for (let i = 1; i < lines.length; i++) {
        if (!singleHan(lines[i])) continue;
        const before = wordsOf(lines[i - 1]);
        let tail = '';
        while (before.length && (!tail.trim() || nonLeading.test(tail))) tail = before.pop() + tail;
        const remainder = before.join('').trimEnd();
        if (remainder && !singleHan(remainder) && fits(tail + lines[i])) {
          lines[i - 1] = remainder;
          lines[i] = tail + lines[i];
        }
      }
    }
    return lines;
  }

  const headline = document.getElementById('article-title') || document.querySelector('article h1');
  const title = (headline?.textContent || document.title).trim();
  // Match the Rust renderer's phrase breaks, including spaces outside each span.
  const titlePhrases = [''];
  for (const node of headline?.childNodes || []) {
    if (node.nodeName === 'WBR') titlePhrases.push('');
    else titlePhrases[titlePhrases.length - 1] += node.textContent;
  }
  const desc = (
    document.querySelector('article p.article-description, article p.meta')?.innerText ||
    document.querySelector('meta[name="description"]')?.content ||
    ''
  ).trim();
  const paragraphs = Array.from(document.querySelectorAll('article .article-body p:not(.meta)'));
  let bodyText = paragraphs
    .map((p) => p.innerText)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (bodyText.length > 130) bodyText = bodyText.substring(0, 130) + '……';

  const date = (document.querySelector('.article-details time')?.innerText || '').trim();
  const readTime = (document.querySelector('.article-details span')?.innerText || '').trim();
  const siteName = (
    document.querySelector('.site-brand .site-title')?.innerText || document.title
  ).trim();
  const author = (document.querySelector('.article-author-name')?.innerText || '').trim();
  const domain = window.location.host + window.location.pathname;

  const titleFont = `600 46px ${readingFont}`;
  const titleLines = getLines(
    title,
    titleFont,
    630,
    titlePhrases.length > 1 ? titlePhrases : [title],
  );

  const descFont = `500 24px ${readingFont}`;
  const descLines = desc ? getLines(desc, descFont, 630) : [];

  const bodyFont = `400 22px ${readingFont}`;
  const bodyLines =
    !desc && bodyText
      ? getLines(bodyText, bodyFont, 630)
      : bodyText
        ? getLines(bodyText, bodyFont, 630).slice(0, 4)
        : [];

  let contentHeight = 160;
  contentHeight += titleLines.length * 64;
  if (descLines.length > 0) contentHeight += 24 + descLines.length * 38;
  if (bodyLines.length > 0) contentHeight += 24 + bodyLines.length * 36;
  contentHeight += 120;

  const width = 800;
  const height = Math.max(480, contentHeight);

  canvas.width = width * 2;
  canvas.height = height * 2;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  ctx.scale(2, 2);

  ctx.fillStyle = surfaceColor;
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(0, 0, width, height, 24);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = dividerColor;
    ctx.stroke();
  } else {
    ctx.fillRect(0, 0, width, height);
  }

  ctx.font = `600 20px ${uiFont}`;
  ctx.fillStyle = textColor;
  ctx.fillText(siteName, 64, 68);

  if (date || readTime) {
    const metaInfo = [date, readTime].filter(Boolean).join(' · ');
    ctx.font = `500 15px ${uiFont}`;
    ctx.fillStyle = mutedColor;
    const metaWidth = ctx.measureText(metaInfo).width;
    ctx.fillText(metaInfo, width - 64 - metaWidth, 68);
  }

  ctx.fillStyle = dividerColor;
  ctx.fillRect(64, 96, width - 128, 1);

  let drawY = 155;
  const accentStartY = drawY - 36;
  const accentHeight = titleLines.length * 64 + (descLines.length ? descLines.length * 38 + 20 : 0);
  ctx.fillStyle = primaryColor;
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(64, accentStartY, 4, accentHeight, 2);
    ctx.fill();
  } else {
    ctx.fillRect(64, accentStartY, 4, accentHeight);
  }

  ctx.fillStyle = textColor;
  ctx.font = titleFont;
  for (const line of titleLines) {
    ctx.fillText(line, 84, drawY);
    drawY += 64;
  }

  if (descLines.length > 0) {
    drawY += 16;
    ctx.fillStyle = primaryColor;
    ctx.font = descFont;
    for (const line of descLines) {
      ctx.fillText(line, 84, drawY);
      drawY += 38;
    }
  }

  if (bodyLines.length > 0) {
    drawY += 20;
    ctx.fillStyle = mutedColor;
    ctx.font = bodyFont;
    for (const line of bodyLines) {
      ctx.fillText(line, 84, drawY);
      drawY += 36;
    }
  }

  const footerY = height - 90;
  ctx.fillStyle = dividerColor;
  ctx.fillRect(64, footerY, width - 128, 1);

  const authorText = author ? author + ' · ' + siteName : siteName;
  ctx.font = `600 16px ${uiFont}`;
  ctx.fillStyle = textColor;
  ctx.fillText(authorText, 64, footerY + 45);

  ctx.font = `500 14px ${uiFont}`;
  ctx.fillStyle = mutedColor;
  const domainWidth = ctx.measureText(domain).width;
  ctx.fillText(domain, width - 64 - domainWidth, footerY + 45);

  const dataUrl = canvas.toDataURL('image/png');

  const content = document.createElement('div');
  content.className = 'share-dialog-content';
  const imgElement = document.createElement('img');
  imgElement.src = dataUrl;
  imgElement.alt = title + ' — 分享卡片';

  const actions = document.createElement('div');
  actions.className = 'share-actions-row';

  const download = document.createElement('a');
  download.href = dataUrl;
  download.download = 'cloudink-share.png';
  download.className = 'share-download';
  download.textContent = t('下载分享图片', 'Download image');
  const downloadStatus = document.createElement('p');
  downloadStatus.className = 'share-download-status';
  downloadStatus.setAttribute('role', 'status');
  download.addEventListener('click', () => {
    downloadStatus.textContent = t('已请求下载分享图片。', 'Image download requested.');
  });
  actions.append(download);

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    const nativeBtn = document.createElement('button');
    nativeBtn.type = 'button';
    nativeBtn.className = 'share-native-btn';
    nativeBtn.textContent = t('系统分享', 'Share via system');
    nativeBtn.addEventListener('click', async () => {
      try {
        await navigator.share({
          title: title,
          text: desc || title,
          url: window.location.href,
        });
      } catch (err) {
        if (err && err.name !== 'AbortError') console.error(err);
      }
    });
    actions.append(nativeBtn);
  }

  content.append(imgElement, actions, downloadStatus);
  showDialog(content, t('分享卡片', 'Share card'), shareBtn);
}
