// playwright-login.mjs — 检查或更新所有供应商登录状态，并自动同步余额
import { createRequire } from 'module';
import { execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'state.json');
const config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));

function isLoginRedirect(url) {
  return /login|passport|signin|account\.xiaomi|sso/i.test(url);
}

async function probeProviderSession(page, p) {
  try {
    const result = await page.evaluate(async ({ apiUrl, method, balancePath }) => {
      const response = await fetch(apiUrl, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Language': 'zh',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: method === 'POST' ? '{}' : undefined,
      });
      const body = await response.json();
      const balance = balancePath.split('.').reduce(
        (value, key) => value == null ? undefined : value[key], body,
      );
      return { status: response.status, code: body.code, balance };
    }, { apiUrl: p.apiUrl, method: p.method, balancePath: p.balancePath });

    return result.status >= 200 && result.status < 300 && result.code === 0 && result.balance != null;
  } catch {
    return false;
  }
}

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
const context = await browser.newContext(
  existsSync(STATE_FILE) ? { storageState: STATE_FILE } : undefined
);

const selected = config.providers.map((_, i) => i);

// 为选中的供应商创建独立标签页，并先尝试复用 state.json 中仍有效的登录态。
const pages = [];
for (const i of selected) {
  const p = config.providers[i];
  console.log(`正在打开 ${p.name} 登录页面...`);
  const pg = await context.newPage();
  await pg.goto(p.homeUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  pages.push(pg);
  // 等待 SPA 初始化和 Cookie 设置
  await new Promise(r => setTimeout(r, 5000));
}

const needsLogin = [];
for (let n = 0; n < selected.length; n++) {
  const p = config.providers[selected[n]];
  const page = pages[n];
  if (isLoginRedirect(page.url())) {
    console.log(`  ${p.name}: ⚠ 登录状态失效，需要重新登录`);
    needsLogin.push(p);
    continue;
  }
  if (await probeProviderSession(page, p)) {
    console.log(`  ${p.name}: ✓ 已登录，余额接口验证成功`);
  } else {
    console.log(`  ${p.name}: ⚠ 暂时无法通过余额接口验证，请检查页面登录状态`);
    needsLogin.push(p);
  }
}

if (needsLogin.length > 0) {
  console.log('\n========================================');
  console.log(' 请在浏览器中完成需要处理的供应商登录：');
  for (const p of needsLogin) console.log(`   - ${p.name}`);
  console.log('\n 登录完成后，回到这里按 Enter 键继续');
  console.log('========================================\n');

  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question('', resolve));
  rl.close();
}

await context.storageState({ path: STATE_FILE });
console.log(`✓ 登录状态已保存到: ${STATE_FILE}`);

await browser.close();

console.log('\n正在自动同步余额到 CC Switch...');
try {
  execFileSync(process.execPath, [join(__dirname, 'playwright-cookie.mjs')], {
    cwd: __dirname,
    stdio: 'inherit',
    windowsHide: true,
  });
} catch (error) {
  console.error('\n自动同步未完成；可以运行 3-sync.bat 重试。');
  process.exitCode = error.status ?? 1;
}
