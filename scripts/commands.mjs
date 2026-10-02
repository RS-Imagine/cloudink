import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
export async function command(file, args, options = {}) {
  await new Promise((accept, reject) => {
    const child = spawn(file, args, { cwd: root, stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? accept() : reject(new Error(`Command failed (${code ?? 'signal'}).`)));
  });
}
