import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMiddleEllipsis,
  markdownToShortPreview,
  formatImageReferenceLabel,
  extractMarkdownHeadings,
  mapScrollBetweenAnchors,
} from '../../cloud-admin/ui/admin-text-utils.js';

test('formatMiddleEllipsis preserves icon variant suffixes distinctly', () => {
  const hash = '7d1a4c9e2b3f5a608192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8';
  const variants = [
    `${hash}-180.png`,
    `${hash}-192.png`,
    `${hash}-512.png`,
    `${hash}-512-maskable.png`,
  ];
  const formatted = variants.map((v) => formatMiddleEllipsis(v, { maxLength: 28, tailLength: 16 }));
  assert.equal(new Set(formatted).size, 4);
  assert.ok(formatted[0].endsWith('-180.png'));
  assert.ok(formatted[1].endsWith('-192.png'));
  assert.ok(formatted[2].endsWith('-512.png'));
  assert.ok(formatted[3].endsWith('-512-maskable.png'));
  assert.equal(formatMiddleEllipsis('cover.webp'), 'cover.webp');
});

test('markdownToShortPreview strips syntax and removes images while keeping text', () => {
  const md = [
    '## 今日随记',
    '',
    '这是一段 **加粗** 与 *斜体* 和 ~~删除线~~，还有 `inline_code` 与 [CloudInk 博客](https://example.com)。',
    '',
    '![桌面截图](/images/uploads/2026/11/a.png)',
    '<img src="/images/uploads/2026/11/b.png" alt="配图" />',
    '',
    '> 引用中的 _重点_ 与 snake_case_name',
    '- 列表第一项',
    '1. 有序第二项',
    '',
    '```js',
    'console.log("hello");',
    '```',
  ].join('\n');

  const plain = markdownToShortPreview(md);
  assert.ok(!plain.includes('**'));
  assert.ok(!plain.includes('!['), 'must remove Markdown image syntax');
  assert.ok(!plain.includes('<img'), 'must remove HTML img tag');
  assert.ok(!plain.includes('```'), 'must strip fenced code syntax');
  assert.ok(!plain.includes('https://example.com'), 'must strip link URL');
  assert.ok(plain.includes('今日随记'));
  assert.ok(plain.includes('加粗'));
  assert.ok(plain.includes('斜体'));
  assert.ok(plain.includes('CloudInk 博客'));
  assert.ok(plain.includes('snake_case_name'));
  assert.ok(plain.includes('代码片段'));
});

test('formatImageReferenceLabel cleanly separates published and draft settings', () => {
  assert.equal(
    formatImageReferenceLabel({ kind: 'settings', title: '网站设置' }),
    '网站设置（已发布）',
  );
  assert.equal(
    formatImageReferenceLabel({ kind: 'settings', title: '线上网站设置' }),
    '网站设置（已发布）',
  );
  assert.equal(
    formatImageReferenceLabel({ kind: 'settings', title: '待发布网站设置' }),
    '网站设置（待发布）',
  );
  assert.equal(
    formatImageReferenceLabel({ kind: 'settings', title: '关于页面' }),
    '网站设置 · 关于页面',
  );
  assert.equal(
    formatImageReferenceLabel({ kind: 'published', title: 'Hello' }),
    '已发布文章 · Hello',
  );
});

test('extractMarkdownHeadings ignores headings inside fenced code blocks', () => {
  const md = [
    '# Title',
    'intro',
    '```md',
    '## Not a heading',
    '```',
    '## Section A',
    'body',
    '### Section B',
  ].join('\n');
  const headings = extractMarkdownHeadings(md);
  assert.equal(headings.length, 3);
  assert.deepEqual(
    headings.map((h) => [h.level, h.text]),
    [
      [1, 'Title'],
      [2, 'Section A'],
      [3, 'Section B'],
    ],
  );
});

test('mapScrollBetweenAnchors aligns headings accurately and falls back proportionally', () => {
  // Editor has heading 1 at 200, heading 2 at 800, max 1000.
  // Preview has heading 1 at 500 (large image above it), heading 2 at 1700, max 2000.
  const srcAnchors = [200, 800];
  const dstAnchors = [500, 1700];
  assert.equal(mapScrollBetweenAnchors(200, srcAnchors, dstAnchors, 1000, 2000), 500);
  assert.equal(mapScrollBetweenAnchors(800, srcAnchors, dstAnchors, 1000, 2000), 1700);
  // Midpoint between heading 1 and heading 2 (500 in editor) -> midpoint in preview (1100).
  assert.equal(mapScrollBetweenAnchors(500, srcAnchors, dstAnchors, 1000, 2000), 1100);
  // Reverse direction (preview 1700 -> editor 800).
  assert.equal(mapScrollBetweenAnchors(1700, dstAnchors, srcAnchors, 2000, 1000), 800);
  // Fallback with zero headings -> proportional.
  assert.equal(mapScrollBetweenAnchors(250, [], [], 1000, 2000), 500);
});
