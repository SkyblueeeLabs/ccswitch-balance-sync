// playwright-auto.mjs — 自动维护所有供应商 Cookie，保持 cc-switch 余额始终可用
import { createRequire } from 'module';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'state.json');
const DB = process.env.USERPROFILE + '\\.cc-switch\\cc-switch.db';
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

function getByPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// 构造余额查询脚本（extractor 内自带取值工具，避免生成超长表达式）
function buildScript(p, cookieHeader) {
  // extractor 收到的是接口原始响应体，data 不会被解包，必须保留完整路径
  return `({
  request: {
    url: "${p.apiUrl}",
    method: "${p.method}",
    headers: {
      "Content-Type": "application/json",
      "X-Client-Language": "zh",
      "X-Requested-With": "XMLHttpRequest",
      "Cookie": ${JSON.stringify(cookieHeader)}
    }${p.method === 'POST' ? ',\n    data: "{}"' : ''}
  },
  extractor: function (response) {
    if (response == null) return { isValid: false, invalidMessage: "响应为空" };
    if (response.code !== 0) {
      return { isValid: false, invalidMessage: response.msg || "查询失败" };
    }
    // 按 "a.b.c" 逐级安全取值，任一级缺失都返回 undefined 而不抛异常
    function pick(path) {
      var cur = response;
      var keys = String(path).split(".");
      for (var i = 0; i < keys.length; i++) {
        if (cur == null) return undefined;
        cur = cur[keys[i]];
      }
      return cur;
    }
    var data = response.data || {};
    return {
      isValid: true,
      planName: "${p.name} 余额",
      remaining: Number(pick(${JSON.stringify(p.balancePath)})) || 0,
      unit: pick(${JSON.stringify(p.currencyPath)}) || "CNY",
      extra: String(data.paygoStatus || data.status || "")
    };
  }
})`;
}

async function queryProvider(page, p) {
  await page.goto(p.homeUrl);
  const result = await page.evaluate(async ({ apiUrl, method }) => {
    const resp = await fetch(apiUrl, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Language': 'zh',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: method === 'POST' ? '{}' : undefined,
    });
    return resp.json();
  }, { apiUrl: p.apiUrl, method: p.method });

  if (result.code !== 0) return { error: result.msg || `code=${result.code}` };
  const balance = getByPath(result, p.balancePath);
  const currency = getByPath(result, p.currencyPath) || 'CNY';
  if (!balance) return { error: '未找到余额字段' };
  return { balance, currency, status: result.data?.paygoStatus || result.data?.status || '' };
}

async function getCookieHeader(context, p) {
  const cookies = await context.cookies();
  return cookies
    .filter(c => c.domain.includes(p.cookieDomain))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

function writeToCCSwitch(p, cookieHeader) {
  const db = new DatabaseSync(DB);
  const rows = db.prepare(
    "SELECT id, meta FROM providers WHERE name LIKE ? AND app_type='claude'"
  ).all(`%${p.matchName}%`);
  if (rows.length === 0) { db.close(); return false; }

  const row = rows[0];
  const meta = JSON.parse(row.meta);
  meta.commonConfigEnabled = false;
  if (!meta.usage_script) {
    meta.usage_script = {
      enabled: true, language: 'javascript', code: '',
      timeout: 10, templateType: 'custom', autoQueryInterval: 5,
    };
  }
  meta.usage_script.templateType = 'custom';
  meta.usage_script.enabled = true;
  meta.usage_script.code = buildScript(p, cookieHeader);

  const bak = DB.replace(/\.db$/, '') + `.backup-${Date.now()}.db`;
  copyFileSync(DB, bak);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE providers SET meta=? WHERE id=?').run(JSON.stringify(meta), row.id);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    db.close();
    return false;
  }
  db.close();
  return true;
}

function restartCCSwitch() {
  try {
    execSync('taskkill /f /im cc-switch.exe', { stdio: 'ignore' });
    setTimeout(() => {
      const exePath = process.env.LOCALAPPDATA + '\\Programs\\CC Switch\\cc-switch.exe';
      execSync(`start "" "${exePath}"`, { stdio: 'ignore' });
    }, 2000);
    console.log('✓ cc-switch 已重启');
  } catch {
    console.log('⚠ 重启失败，请手动重启 cc-switch');
  }
}

// ==================== 主流程 ====================
console.log('正在检查所有供应商 Cookie 状态...\n');

// 从 state.json 读取某供应商的 Cookie 头
function cookieHeaderFromState(state, p) {
  if (!state || !Array.isArray(state.cookies)) return '';
  return state.cookies
    .filter(c => c.domain && c.domain.includes(p.cookieDomain))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

// 直接用 HTTP 查询余额（无需浏览器，适合计划任务）
async function queryProviderHttp(p, cookieHeader) {
  const resp = await fetch(p.apiUrl, {
    method: p.method,
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Language': 'zh',
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': cookieHeader,
    },
    body: p.method === 'POST' ? '{}' : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const result = await resp.json();
  if (result.code !== 0) return { error: result.msg || `code=${result.code}` };
  const balance = getByPath(result, p.balancePath);
  const currency = getByPath(result, p.currencyPath) || 'CNY';
  if (balance == null) return { error: '未找到余额字段' };
  return { balance, currency };
}

// 第 1 步: 用现有 state.json 直接查询（不启动浏览器）
let needRelogin = false;
let anyOk = false;

if (existsSync(STATE_FILE)) {
  let state = null;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    console.log('⚠ state.json 无法解析，需要重新登录');
    needRelogin = true;
  }

  if (state) {
    for (const p of config.providers) {
      const cookieHeader = cookieHeaderFromState(state, p);
      if (!cookieHeader) {
        console.log(`  ${p.name}: 无 Cookie，需要登录`);
        needRelogin = true;
        continue;
      }
      try {
        const result = await queryProviderHttp(p, cookieHeader);
        if (result.error) {
          console.log(`  ${p.name}: Cookie 已过期 (${result.error})`);
          needRelogin = true;
          continue;
        }
        const ok = writeToCCSwitch(p, cookieHeader);
        if (ok) {
          anyOk = true;
          console.log(`  ${p.name}: ✓ 余额 ${result.balance} ${result.currency}`);
        } else {
          console.log(`  ${p.name}: 查到余额 ${result.balance}，但写入 CC Switch 失败`);
        }
      } catch (e) {
        console.log(`  ${p.name}: Cookie 已过期 (${e.message})`);
        needRelogin = true;
      }
    }
  }
} else {
  console.log('  未找到 state.json，需要先登录');
  needRelogin = true;
}

// 第 2 步: 全部有效，直接重启
if (!needRelogin) {
  console.log('\n全部 Cookie 有效，正在重启 cc-switch...');
  restartCCSwitch();
  process.exit(0);
}

// 第 3 步: 有 Cookie 过期 —— 需要人工重新登录
// 计划任务是无人值守的，无法等待输入，此时只提示，不弹窗阻塞
if (!process.stdin.isTTY) {
  console.log('\n⚠ 有供应商需要重新登录，但当前为无人值守运行。');
  console.log('  请手动双击 2-login.bat 重新登录后，再运行 3-sync.bat。');
  if (anyOk) {
    console.log('  （已成功刷新部分供应商，正在重启 cc-switch...）');
    restartCCSwitch();
  }
  process.exit(needRelogin && !anyOk ? 1 : 0);
}

console.log('========================================');
console.log(' 正在打开浏览器，请重新登录过期的供应商');
console.log(' 登录完成后回到这里按 Enter');
console.log('========================================\n');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext(
  existsSync(STATE_FILE) ? { storageState: STATE_FILE } : undefined
);
const page = await context.newPage();

for (const p of config.providers) {
  await page.goto(p.loginUrl);
  await new Promise(r => setTimeout(r, 1500));
}

await new Promise(resolve => {
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', resolve);
});

await context.storageState({ path: STATE_FILE });
console.log('\n✓ 登录状态已保存');

// 重新查询并写入
let allOk = true;
for (const p of config.providers) {
  try {
    const result = await queryProvider(page, p);
    if (result.error) {
      console.log(`  ${p.name}: ✗ ${result.error}`);
      allOk = false;
      continue;
    }
    const cookieHeader = await getCookieHeader(context, p);
    const ok = writeToCCSwitch(p, cookieHeader);
    console.log(`  ${p.name}: ✓ 余额 ${result.balance} ${result.currency}`);
  } catch (e) {
    console.log(`  ${p.name}: ✗ ${e.message}`);
    allOk = false;
  }
}

await browser.close();

if (allOk) {
  console.log('\n全部同步成功，正在重启 cc-switch...');
  restartCCSwitch();
} else {
  console.log('\n部分同步失败，请检查上方错误信息。');
}
