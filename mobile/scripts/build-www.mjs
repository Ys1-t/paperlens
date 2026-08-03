// 组装 Capacitor 的 www/：复制 app/（PWA 壳）+ src/lib、src/vendor（与扩展共享的核心）
// + icons/。不改动仓库其他目录；www/ 是一次性构建产物（已 gitignore）。
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(mobileDir);
const www = join(mobileDir, 'www');

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });

// 与 GitHub Pages 完全相同的目录关系（app/ 里的 ../src/... 相对路径原样成立）。
cpSync(join(repoRoot, 'app'), join(www, 'app'), { recursive: true });
cpSync(join(repoRoot, 'src', 'lib'), join(www, 'src', 'lib'), { recursive: true });
cpSync(join(repoRoot, 'src', 'vendor'), join(www, 'src', 'vendor'), { recursive: true });
cpSync(join(repoRoot, 'icons'), join(www, 'icons'), { recursive: true });

// Capacitor 默认加载 www/index.html：立即跳到 PWA 壳。
writeFileSync(join(www, 'index.html'), [
  '<!DOCTYPE html>',
  '<html><head><meta charset="UTF-8" />',
  '<script>location.replace("./app/index.html");</script>',
  '</head><body></body></html>',
  '',
].join('\n'));

if (!existsSync(join(www, 'app', 'index.html'))) {
  console.error('build-www: app/index.html missing');
  process.exit(1);
}
console.log('build-www: assembled', www);
