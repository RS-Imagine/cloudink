import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from '../cloud-admin/node_modules/esbuild/lib/main.js';
import { root } from './deployment-config.mjs';
const content = resolve(root, 'build-work/web-content');
const output = resolve(root, 'build-work/web-public');
if (process.argv[2] === 'seed') {
  // Never read deployment secrets or private articles during a template build.
  await rm(content, { recursive: true, force: true });
  await rm(output, { recursive: true, force: true });
  await mkdir(content, { recursive: true });
  await writeFile(resolve(content, 'site.toml'), 'title = "CloudInk"\nsubtitle = "Notes and ideas"\nauthor = "Your Name"\ndescription = "A personal blog powered by CloudInk."\n');
  await writeFile(resolve(content, 'about.md'), '+++\ntitle = "About"\n+++\n\nWelcome to my blog.');
} else if (process.argv[2] === 'bundle') {
  const source = await readFile(resolve(root, 'crates/blog-core/src/assets/client.js'), 'utf8');
  await build({ stdin: { contents: `import Swup from 'swup';\nimport hljs from './cloud-admin/node_modules/highlight.js/lib/common';\nwindow.Swup = Swup; window.hljs = hljs;\n${source}`, resolveDir: root, sourcefile: 'public-client.js' }, outfile: resolve(output, 'client.js'), bundle: true, format: 'iife', target: 'es2022', minify: true });
  await writeFile(resolve(output, 'theme.js'), await readFile(resolve(root, 'cloud-web/theme.js')));
} else throw new Error('Expected seed or bundle.');
