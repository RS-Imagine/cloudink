import { readFile, writeFile, mkdir, rm, readdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build, transform } from '../cloud-admin/node_modules/esbuild/lib/main.js';
import { root } from './commands.mjs';
const content = resolve(root, 'build-work/web-content');
const output = resolve(root, 'build-work/web-public');
if (process.argv[2] === 'seed') {
  // Never read deployment secrets or private articles during a template build.
  await rm(content, { recursive: true, force: true });
  await rm(output, { recursive: true, force: true });
  await mkdir(content, { recursive: true });
  await mkdir(resolve(content, 'posts'), { recursive: true });
  await writeFile(
    resolve(content, 'site.toml'),
    'title = "CloudInk · 云砚"\nsubtitle = "独立开发者 / 产品思考者"\nauthor = "QiuLin"\ndescription = "喜欢把复杂的技术讲清楚，也记录日常的灵感与实践。专注于 Web 与可观测性，习惯把想法写下来。"\ntheme_palette = "brown"\n',
  );
  await writeFile(
    resolve(content, 'about.md'),
    '+++\ntitle = "关于"\n+++\n\n独立开发者 / 产品思考者。专注于 Web 与可观测性，习惯把想法写下来。',
  );
  await writeFile(
    resolve(content, 'posts/rebuild-blog.md'),
    `+++
title = "用 Astro 重构我的个人博客"
date = "2024-05-20"
slug = "rebuild-blog"
description = "从架构选择、内容建模到性能优化，记录一次完整的静态站点重构过程。"
tags = ["Astro", "静态站点", "性能优化"]
+++

在决定重启个人博客时，我给自己定了三个要求：快、稳、省。静态生成恰好同时满足这三个目标。

静态网站没有运行时依赖，部署简单，访问速度快，安全面也更小。对于不希望把精力花在运维上的个人开发者来说，这是一个非常务实的选择。

## 为什么选择静态生成

在过去的几年里，我尝试过很多种博客系统：WordPress、Ghost、Notion + Next.js，以及各种静态博客生成器。

每一种方案都有它的优势，但在长期维护的过程中，我发现自己花在维护服务器、升级插件、处理数据库备份上的时间，远远超过了真正写字的时间。

静态生成的最大优势在于：**产物是纯粹的 HTML、CSS 和 JavaScript**。
`,
  );
  await writeFile(
    resolve(content, 'posts/observability-practice.md'),
    `+++
title = "从日志到指标：我的可观测性实践"
date = "2024-04-28"
slug = "observability-practice"
description = "构建可观测性体系的思路与工具选型，如何让系统问题被更早发现。"
tags = ["可观测性", "OpenTelemetry"]
+++

很多团队在系统出现问题时，第一反应往往是去翻日志。但当系统规模逐渐扩大，单靠日志检索就像大海捞针。

构建可观测性体系的核心思路：从指标（Metrics）发现异常，通过链路追踪（Tracing）定位瓶颈，最后用结构化日志（Logs）确认细节。
`,
  );
  await writeFile(
    resolve(content, 'posts/commute-efficiency.md'),
    `+++
title = "一周通勤中的效率实验"
date = "2024-04-15"
slug = "commute-efficiency"
description = "在通勤时间里尝试的小技巧与工具，提升专注力与输入输出的质量。"
tags = ["效率", "通勤", "生活"]
+++

每天往返两小时的通勤时间，如果只是刷碎片化信息流，很容易感到疲惫。

上周我做了一个小实验：用手机端轻量写作工具记录微碎片想法（短记），在车厢里阅读长文。这种输入与输出的微循环，让通勤变成了全天最专注的时段。
`,
  );
  await writeFile(
    resolve(content, 'posts/performance-optimization.md'),
    `+++
title = "优化博客性能：从图片到加载体验"
date = "2024-04-02"
slug = "performance-optimization"
description = "分享我在 CloudInk 中优化性能的实践，包括图片压缩、按需加载、缓存策略与监控。"
tags = ["性能优化", "JavaScript"]
+++

页面加载速度直接影响读者的第一印象。为了让博客达到极致的加载速度，我从资源打包、首屏渲染、图片格式等维度进行了系统性优化。
`,
  );
} else if (process.argv[2] === 'bundle') {
  const { template_version: version } = JSON.parse(
    await readFile(resolve(output, 'site.json'), 'utf8'),
  );
  if (!/^[a-f0-9]{64}$/.test(version || '')) throw new Error('Missing Rust template fingerprint.');
  await writeFile(
    resolve(root, 'cloud-admin/src/template-version.generated.ts'),
    '// Generated from the Rust renderer. Do not edit.\n' +
      'export const CURRENT_TEMPLATE_VERSION = ' +
      JSON.stringify(version) +
      ';\n',
  );
  const motion = await readFile(resolve(root, 'assets/motion.js'), 'utf8');
  const mobile = await readFile(resolve(root, 'assets/mobile.js'), 'utf8');
  const runtime = await readFile(resolve(root, 'assets/reader-runtime.js'), 'utf8');
  const source = await readFile(resolve(root, 'crates/blog-core/src/assets/client.js'), 'utf8');
  await build({
    stdin: {
      contents: `import Swup from 'swup';\nwindow.Swup = Swup;\n${motion}\n${mobile}\n${runtime}\n${source}`,
      resolveDir: root,
      sourcefile: 'public-client.js',
    },
    outfile: resolve(output, 'client.js'),
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: true,
  });
  const stylesheetPath = resolve(output, 'styles.css');
  const styleSource = await readFile(stylesheetPath, 'utf8');
  // Retain the Rust output outside public assets for controlled CSS comparisons.
  await writeFile(resolve(root, 'build-work/web-styles.source.css'), styleSource);
  const cssOptions = {
    loader: 'css',
    minify: true,
    target: ['chrome100', 'firefox100', 'safari15'],
  };
  const styleParts = [];
  let remainingStyles = styleSource;
  // Keep the same canonical theme and foundation bytes used by the editor.
  for (const path of ['assets/design-tokens.css', 'assets/design-foundation.css']) {
    const shared = await readFile(resolve(root, path), 'utf8');
    const offset = remainingStyles.indexOf(shared);
    if (offset < 0) throw new Error('Missing shared stylesheet: ' + path);
    if (offset > 0)
      styleParts.push((await transform(remainingStyles.slice(0, offset), cssOptions)).code);
    styleParts.push(shared);
    remainingStyles = remainingStyles.slice(offset + shared.length);
  }
  if (remainingStyles) styleParts.push((await transform(remainingStyles, cssOptions)).code);
  const stylesheet = styleParts.join('\n');
  await writeFile(stylesheetPath, stylesheet);
  console.log(
    JSON.stringify({
      asset: 'public/styles.css',
      gzip: gzipSync(stylesheet).length,
      sourceGzip: gzipSync(styleSource).length,
    }),
  );
  const vendor = resolve(output, 'reader-assets');
  await mkdir(resolve(vendor, 'fonts'), { recursive: true });
  await build({
    stdin: {
      contents:
        "import hljs from './cloud-admin/node_modules/highlight.js/lib/common'; window.CloudInkHighlighter = hljs;",
      resolveDir: root,
    },
    outfile: resolve(vendor, 'highlight.js'),
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: true,
  });
  // Ship only WOFF2 Unicode slices; readers never contact a font CDN.
  const fontRoot = resolve(root, 'cloud-admin/node_modules/@fontsource/noto-serif-sc');
  let fontCSS = '';
  for (const weight of [400, 600]) {
    // Keep Latin on the stable system serif: swapping it reflows English headings.
    // Han glyphs retain their one-em advance, even while the font is downloading.
    const source = (await readFile(resolve(fontRoot, weight + '.css'), 'utf8')).replace(
      /@font-face\s*\{[^}]+\}/g,
      (rule) => {
        const ranges = rule.match(/unicode-range:\s*([^;]+);/)?.[1] || '';
        const retained = [];
        for (const range of ranges.split(',')) {
          const [first, last = first] = range.trim().replace(/^U\+/i, '').split('-');
          const start = parseInt(first, 16),
            end = parseInt(last, 16);
          for (const [low, high] of [
            [0x2e80, 0x9fff],
            [0xf900, 0xfaff],
            [0xff00, 0xffef],
            [0x20000, 0x323af],
          ]) {
            const a = Math.max(start, low),
              b = Math.min(end, high);
            if (a <= b)
              retained.push('U+' + a.toString(16) + (a === b ? '' : '-' + b.toString(16)));
          }
        }
        return retained.length
          ? rule.replace(/unicode-range:[^;]+;/, 'unicode-range:' + retained.join(',') + ';')
          : '';
      },
    );
    const files = [...source.matchAll(/url\(\.\/files\/([a-z0-9-]+\.woff2)\)/g)];
    if (!files.length) throw new Error('Missing editorial WOFF2 slices');
    for (const [, file] of files)
      await copyFile(resolve(fontRoot, 'files', file), resolve(vendor, 'fonts', file));
    fontCSS += source.replace(/src:[^;]+;/g, (declaration) => {
      const file = declaration.match(/url\(\.\/files\/([a-z0-9-]+\.woff2)\)/)?.[1];
      if (!file) throw new Error('Missing editorial font source');
      return 'src:url(/reader-assets/fonts/' + file + ') format("woff2");';
    });
  }
  await writeFile(resolve(vendor, 'editorial-font.css'), fontCSS);
  await copyFile(resolve(fontRoot, 'LICENSE'), resolve(vendor, 'editorial-font-LICENSE.txt'));
  const highlightRoot = resolve(root, 'cloud-admin/node_modules/highlight.js');
  const light = await readFile(resolve(highlightRoot, 'styles/github.min.css'), 'utf8');
  const dark = await readFile(resolve(highlightRoot, 'styles/github-dark.min.css'), 'utf8');
  const themed = await transform(
    ':root:not([data-theme="dark"]) {' + light + '}\n:root[data-theme="dark"] {' + dark + '}',
    {
      loader: 'css',
      minify: true,
      target: ['chrome100', 'firefox100', 'safari15'],
    },
  );
  await writeFile(resolve(vendor, 'code.css'), themed.code);
  const mathRoot = resolve(root, 'cloud-admin/node_modules/katex');
  let mathCSS = await readFile(resolve(mathRoot, 'dist/katex.min.css'), 'utf8');
  mathCSS = mathCSS.replace(/src:[^;}]+(?=;|})/g, (declaration) => {
    const source = declaration.match(/url\(([^)]+\.woff2)\)/);
    if (!source) throw new Error('A KaTeX font has no WOFF2 source');
    return 'src:url(' + source[1] + ') format("woff2")';
  });
  await writeFile(resolve(vendor, 'katex.css'), mathCSS);
  for (const file of await readdir(resolve(mathRoot, 'dist/fonts'))) {
    if (file.endsWith('.woff2'))
      await copyFile(resolve(mathRoot, 'dist/fonts', file), resolve(vendor, 'fonts', file));
  }
  await copyFile(resolve(mathRoot, 'LICENSE'), resolve(vendor, 'katex-LICENSE.txt'));
  await copyFile(resolve(highlightRoot, 'LICENSE'), resolve(vendor, 'highlight-LICENSE.txt'));
  await writeFile(resolve(output, 'theme.js'), await readFile(resolve(root, 'assets/theme.js')));
  await copyFile(resolve(root, 'assets/manifest.webmanifest'), resolve(output, 'manifest.webmanifest'));
  await copyFile(resolve(root, 'assets/sw.js'), resolve(output, 'sw.js'));
  await writeFile(
    resolve(output, '_headers'),
    [
      '/client.js',
      '  X-Content-Type-Options: nosniff',
      '/theme.js',
      '  X-Content-Type-Options: nosniff',
      '/styles.css',
      '  X-Content-Type-Options: nosniff',
      '/favicon.svg',
      '  X-Content-Type-Options: nosniff',
      "  Content-Security-Policy: sandbox; default-src 'none'",
      '/manifest.webmanifest',
      '  X-Content-Type-Options: nosniff',
      '  Content-Type: application/manifest+json; charset=utf-8',
      '/sw.js',
      '  X-Content-Type-Options: nosniff',
      '  Content-Type: application/javascript; charset=utf-8',
      '/reader-assets/*',
      '  X-Content-Type-Options: nosniff',
    ].join('\n') + '\n',
  );
} else throw new Error('Expected seed or bundle.');
