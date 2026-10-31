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
    'title = "CloudInk"\nsubtitle = "Notes and ideas"\nauthor = "Your Name"\ndescription = "A personal blog powered by CloudInk."\n',
  );
  await writeFile(resolve(content, 'about.md'), '+++\ntitle = "About"\n+++\n\nWelcome to my blog.');
} else if (process.argv[2] === 'bundle') {
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
  const stylesheet = await transform(styleSource, {
    loader: 'css',
    minify: true,
    target: ['chrome100', 'firefox100', 'safari15'],
  });
  await writeFile(stylesheetPath, stylesheet.code);
  console.log(
    JSON.stringify({
      asset: 'public/styles.css',
      gzip: gzipSync(stylesheet.code).length,
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
} else throw new Error('Expected seed or bundle.');
