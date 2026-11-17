import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const prod = process.env.NODE_ENV !== 'development';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: prod ? false : 'inline',
  minify: false,
  logLevel: 'info',
  legalComments: 'none',
};

await build({
  ...common,
  entryPoints: [path.join(root, 'src/main/main.ts')],
  outfile: path.join(root, 'dist/main/main.js'),
  external: ['electron'],
});

await build({
  ...common,
  entryPoints: [path.join(root, 'src/preload/preload.ts')],
  outfile: path.join(root, 'dist/preload/preload.js'),
  external: ['electron'],
});

// Headless Linux server; ships separately from the Windows app (see deploy/).
await build({
  ...common,
  entryPoints: [path.join(root, 'src/server/main.ts')],
  outfile: path.join(root, 'dist/server/oda-server.cjs'),
  external: ['better-sqlite3'],
});

const assets = path.join(root, 'dist/assets');
fs.mkdirSync(assets, { recursive: true });
for (const f of ['icon.png', 'icon.ico']) {
  const src = path.join(root, 'build', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(assets, f));
  else console.warn(`missing build/${f} — run "npm run icon"`);
}
