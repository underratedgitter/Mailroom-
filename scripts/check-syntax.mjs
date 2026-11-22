// Parses every shipped JavaScript file (bin, src, public) without running it,
// so a syntax error fails CI even in a file no test imports (such as the
// browser script).
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const files = ['bin', 'src', 'public']
  .flatMap((dir) => readdirSync(join(root, dir), { recursive: true }).map((name) => join(root, dir, name)))
  .filter((path) => /\.m?js$/.test(path))
  .sort();

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    console.error(result.stderr.trim());
  }
}

console.log(`${files.length - failed}/${files.length} files parse`);
process.exit(failed ? 1 : 0);
