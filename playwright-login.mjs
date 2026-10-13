// playwright-login.mjs — 弹出浏览器，登录所有供应商，保存登录状态
import { createRequire } from 'module';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'state.json');
const config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));

async function loadPlaywright() {
  // 1. 本地 node_modules
  try {
    return await import('playwright');
  } catch {}

  // 2. 常见全局安装路径（不依赖 execSync，兼容受限环境）
  const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  const candidates = [
    join(appdata, 'npm', 'node_modules', 'playwright'),
    join(homedir(), 'AppData', 'Local', 'npm', 'node_modules', 'playwright'),
    process.env.NODE_PATH,
    '/usr/local/lib/node_modules/playwright',
    '/usr/lib/node_modules/playwright',
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      if (!existsSync(join(dir, 'package.json'))) continue;
      const require = createRequire(join(dir, 'package.json'));
      return require('playwright');
    } catch {}
  }

  // 3. 最后尝试 npm root -g
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const require = createRequire(join(globalRoot, 'noop.js'));
    return require('playwright');
  } catch {}

  throw new Error('找不到 Playwright，请运行: npm install -g playwright && npx playwright install chromium');
}

const { chromium } = await loadPlaywright();

console.log('正在启动浏览器...\n');
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();

// 让用户勾选要登录的供应商
console.log('请选择要登录的供应商：');
config.providers.forEach((p, i) => {
  console.log(`  [${i + 1}] ${p.name}`);
});
console.log('');

const readline = await import('node:readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const answer = await new Promise(resolve => {
  rl.question('请输入编号（多个用逗号分隔，如 1,2；直接回车=全部）：', resolve);
});

// 解析用户选择
let selected = [];
if (answer.trim() === '') {
  selected = config.providers.map((_, i) => i);  // 全部
} else {
  selected = answer.split(',').map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < config.providers.length);
}

if (selected.length === 0) {
  console.log('未选择任何供应商，退出。');
  await browser.close();
  process.exit(0);
}

console.log(`\n已选择：${selected.map(i => config.providers[i].name).join(', ')}\n`);

// 为选中的供应商创建独立标签页
const pages = [];
for (const i of selected) {
  const p = config.providers[i];
  console.log(`正在打开 ${p.name} 登录页面...`);
  const pg = await context.newPage();
  await pg.goto(p.loginUrl);
  pages.push(pg);
  await new Promise(r => setTimeout(r, 1000));
}

console.log('\n========================================');
console.log(' 请在浏览器里登录以下供应商：');
for (const i of selected) {
  console.log(`   - ${config.providers[i].name}`);
}
console.log('\n 全部登录完成后，回到这里按 Enter 键');
console.log('========================================\n');

// 用 readline 等待用户按 Enter
await new Promise(resolve => {
  rl.question('', resolve);
});
rl.close();

await context.storageState({ path: STATE_FILE });
console.log(`✓ 登录状态已保存到: ${STATE_FILE}`);

await browser.close();
console.log('\n完成。运行 3-sync.bat 即可同步余额。');
