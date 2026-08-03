// 打包可分发的扩展 zip：只收录 manifest + src + icons + LICENSE + README，排除开发文件。
// 用法：npm run pack  →  生成 dist/paperlens-<version>.zip
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
const distDir = join(root, 'dist');
if (!existsSync(distDir)) mkdirSync(distDir);
const outFile = join(distDir, `paperlens-${version}.zip`);

const INCLUDE_TOP = ['manifest.json', 'src', 'icons', 'LICENSE', 'README.md'];

function collect(dir, base) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) files.push(...collect(full, base));
    else files.push(relative(base, full));
  }
  return files;
}

const entries = [];
for (const top of INCLUDE_TOP) {
  const full = join(root, top);
  if (!existsSync(full)) continue;
  if (statSync(full).isDirectory()) entries.push(...collect(full, root));
  else entries.push(top);
}

// 优先用系统 zip；Windows 无 zip 时退回 PowerShell Compress-Archive（保持相对目录结构）。
try {
  execFileSync('zip', ['-q', '-X', outFile, ...entries.map((e) => e.split(sep).join('/'))], { cwd: root });
} catch {
  const psItems = INCLUDE_TOP.filter((t) => existsSync(join(root, t))).map((e) => `'${e}'`).join(',');
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -Force -Path ${psItems} -DestinationPath '${outFile}'`,
  ], { cwd: root });
}

const size = statSync(outFile).size;
console.log(`packed ${relative(root, outFile)} (${(size / 1024 / 1024).toFixed(2)} MB, ${entries.length} files)`);
