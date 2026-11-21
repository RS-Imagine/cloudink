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
  await writeFile(
    resolve(content, 'site.toml'),
    'title = "CloudInk"\nsubtitle = "记录所见，整理所想"\nauthor = "CloudInk"\ndescription = "使用后台设置你的博客，开始第一篇文章。"\n',
  );
  await writeFile(resolve(content, 'about.md'), '+++\ntitle = "About"\n+++\n\nWelcome to my blog.');
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
  await build({
    entryPoints: [resolve(root, 'assets/reader-share-card.js')],
    outfile: resolve(vendor, 'share-card.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
  });
  // Ship only WOFF2 Unicode slices; readers never contact a font CDN.
  const fontRoot = resolve(root, 'cloud-admin/node_modules/@fontsource/noto-serif-sc');
  let fontCSS = '';
  for (const weight of [400, 600]) {
    // Latin (with true italics) is served by standalone Noto Serif below; SC remains scoped
    // to CJK and fullwidth ranges so Han glyphs retain their one-em advance while downloading.
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
  const latinFontRoot = resolve(root, 'cloud-admin/node_modules/@fontsource/noto-serif');
  let latinFaceCount = 0;
  for (const sheet of ['400.css', '400-italic.css', '600.css', '600-italic.css']) {
    const raw = await readFile(resolve(latinFontRoot, sheet), 'utf8');
    const matches = [
      ...raw.matchAll(
        /\/\*\s*(noto-serif-(?:latin|latin-ext)-(?:400|600)-(?:normal|italic))\s*\*\/\s*(@font-face\s*\{[^}]+\})/g,
      ),
    ];
    if (matches.length !== 2)
      throw new Error('Expected latin and latin-ext slices in @fontsource/noto-serif/' + sheet);
    for (const [, label, rule] of matches) {
      const file = rule.match(/url\(\.\/files\/([a-z0-9-]+\.woff2)\)/)?.[1];
      if (!file) throw new Error('Missing Latin editorial WOFF2 slice: ' + label);
      await copyFile(resolve(latinFontRoot, 'files', file), resolve(vendor, 'fonts', file));
      fontCSS +=
        `\n/* ${label} */\n` +
        rule.replace(/src:[^;]+;/g, 'src:url(/reader-assets/fonts/' + file + ') format("woff2");') +
        '\n';
      latinFaceCount++;
    }
  }
  if (latinFaceCount !== 8) throw new Error('Unexpected Noto Serif Latin face count');
  await writeFile(resolve(vendor, 'editorial-font.css'), fontCSS);
  const scLicense = (await readFile(resolve(fontRoot, 'LICENSE'), 'utf8')).trim();
  const latinLicense = (await readFile(resolve(latinFontRoot, 'LICENSE'), 'utf8')).trim();
  await writeFile(
    resolve(vendor, 'editorial-font-LICENSE.txt'),
    [
      '=== Noto Serif SC (@fontsource/noto-serif-sc) ===',
      scLicense,
      '',
      '=== Noto Serif (@fontsource/noto-serif) ===',
      latinLicense,
      '',
    ].join('\n'),
  );
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
  await copyFile(
    resolve(root, 'assets/manifest.webmanifest'),
    resolve(output, 'manifest.webmanifest'),
  );
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
