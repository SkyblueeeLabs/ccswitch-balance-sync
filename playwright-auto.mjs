// playwright-auto.mjs — 自动维护所有供应商 Cookie，保持 cc-switch 余额始终可用
import { createRequire } from 'module';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync, copyFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
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

function getByPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// CC Switch 直接查询现金余额；Token Plan 使用最近一次后台同步的快照。
function buildScript(p, cookieHeader, tokenPlan) {
  return `({
  request: {
    url: ${JSON.stringify(p.apiUrl)},
    method: ${JSON.stringify(p.method)},
    headers: {
      "Content-Type": "application/json",
      "X-Client-Language": "zh",
      "X-Requested-With": "XMLHttpRequest",
      "Cookie": ${JSON.stringify(cookieHeader)}
    }${p.method === 'POST' ? `,\n    body: "{}"` : ''}
  },
  extractor: function (response) {
    if (response == null || response.code !== 0) return { isValid: false, invalidMessage: (response && response.msg) || "查询失败" };
    function pick(path) {
      var value = response;
      var keys = path.split(".");
      for (var i = 0; i < keys.length; i++) {
        if (value == null) return undefined;
        value = value[keys[i]];
      }
      return value;
    }
    var rawBalance = pick(${JSON.stringify(p.balancePath)});
    if (rawBalance == null || !isFinite(Number(rawBalance))) return { isValid: false, invalidMessage: "未找到余额字段" };
    var balance = Number(rawBalance);
    var currency = pick(${JSON.stringify(p.currencyPath)}) || "CNY";
    var tokenPlan = ${tokenPlan == null ? 'null' : JSON.stringify(tokenPlan)};
    return {
      isValid: true,
      planName: ${JSON.stringify(p.name)},
      remaining: balance,
      unit: tokenPlan == null ? currency : "¥ · " + (tokenPlan / 10000).toFixed(1) + "万",
      extra: ""
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
  if (balance == null) return { error: '未找到余额字段' };

  // 查 token plan
  let tokenPlan = null;
  let tokenPlanError = null;
  if (p.tokenPacksApiUrl) {
    try {
      const r2 = await page.evaluate(async (apiUrl) => {
        const resp = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-Language': 'zh', 'X-Requested-With': 'XMLHttpRequest' },
          body: '{}',
        });
        return resp.json();
      }, p.tokenPacksApiUrl);
      if (r2.code === 0) {
        const lots = [r2.data?.currentLot].concat(r2.data?.otherLots || []).filter(Boolean);
        tokenPlan = lots.reduce((sum, lot) => sum + (Number(lot.remainingToken) || 0), 0);
      } else {
        tokenPlanError = r2.msg || `code=${r2.code}`;
      }
    } catch (e) {
      tokenPlanError = e.message;
    }
  }

  return { balance, currency, tokenPlan, tokenPlanError };
}

async function getCookieHeader(context, p) {
  const cookies = await context.cookies();
  return cookies
    .filter(c => c.domain.includes(p.cookieDomain))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

let backupCreated = false;

function backupDatabaseOnce() {
  if (backupCreated) return;
  const backupDir = dirname(DB);
  const backupPath = DB.replace(/\.db$/, '') + `.backup-${Date.now()}.db`;
  copyFileSync(DB, backupPath);
  backupCreated = true;
  const backups = readdirSync(backupDir)
    .filter(name => name.startsWith('cc-switch.backup-') && name.endsWith('.db'))
    .map(name => ({ path: join(backupDir, name), modified: statSync(join(backupDir, name)).mtimeMs }))
    .sort((a, b) => b.modified - a.modified);
  for (const old of backups.slice(20)) {
    try { unlinkSync(old.path); } catch {}
  }
}

function writeToCCSwitch(p, cookieHeader, tokenPlan) {
  const db = new DatabaseSync(DB);
  const rows = db.prepare(
    "SELECT id, meta FROM providers WHERE name LIKE ? AND app_type='claude'"
  ).all(`%${p.matchName}%`);
  if (rows.length === 0) { db.close(); return { ok: false, changed: false }; }

  const row = rows[0];
  const meta = JSON.parse(row.meta);
  meta.commonConfigEnabled = false;
  if (!meta.usage_script) {
    meta.usage_script = {
      enabled: true, language: 'javascript', code: '',
      timeout: 10, templateType: 'custom', autoQueryInterval: 5,
    };
  }
  let effectiveTokenPlan = tokenPlan;
  if (effectiveTokenPlan == null && p.tokenPacksApiUrl) {
    const currentCode = meta.usage_script.code;
    const cached = typeof currentCode === 'string'
      ? currentCode.match(/var tokenPlan = (null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?);/)
      : null;
    if (cached && cached[1] !== 'null' && Number.isFinite(Number(cached[1]))) {
      effectiveTokenPlan = Number(cached[1]);
    }
  }
  const newCode = buildScript(p, cookieHeader, effectiveTokenPlan);
  const originalMeta = JSON.parse(row.meta);
  const changed = originalMeta.commonConfigEnabled !== false ||
    meta.usage_script.templateType !== 'custom' ||
    meta.usage_script.enabled !== true ||
    meta.usage_script.autoQueryInterval !== 5 ||
    meta.usage_script.code !== newCode;
  if (!changed) {
    db.close();
    return { ok: true, changed: false };
  }
  meta.usage_script.templateType = 'custom';
  meta.usage_script.enabled = true;
  meta.usage_script.autoQueryInterval = 5;
  meta.usage_script.code = newCode;

  backupDatabaseOnce();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE providers SET meta=? WHERE id=?').run(JSON.stringify(meta), row.id);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    db.close();
    return { ok: false, changed: false };
  }
  db.close();
  return { ok: true, changed: true };
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
  const headers = {
    'Content-Type': 'application/json',
    'X-Client-Language': 'zh',
    'X-Requested-With': 'XMLHttpRequest',
    'Cookie': cookieHeader,
  };

  // 查主接口（现金余额）
  const resp = await fetch(p.apiUrl, {
    method: p.method,
    headers,
    body: p.method === 'POST' ? '{}' : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const result = await resp.json();
  if (result.code !== 0) return { error: result.msg || `code=${result.code}` };
  const balance = getByPath(result, p.balancePath);
  const currency = getByPath(result, p.currencyPath) || 'CNY';
  if (balance == null) return { error: '未找到余额字段' };

  // 查 token plan（可选）
  let tokenPlan = null;
  let tokenPlanError = null;
  if (p.tokenPacksApiUrl) {
    try {
      const r2 = await fetch(p.tokenPacksApiUrl, {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(10000),
      });
      const j2 = await r2.json();
      if (j2.code === 0) {
        const lots = [j2.data?.currentLot].concat(j2.data?.otherLots || []).filter(Boolean);
        tokenPlan = lots.reduce((sum, lot) => sum + (Number(lot.remainingToken) || 0), 0);
      } else {
        tokenPlanError = j2.msg || `code=${j2.code}`;
      }
    } catch (e) {
      tokenPlanError = e.message;
    }
  }

  return { balance, currency, tokenPlan, tokenPlanError };
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
        const write = writeToCCSwitch(p, cookieHeader, result.tokenPlan);
        if (write.ok) {
          anyOk = true;
          const planNote = result.tokenPlanError ? '；Token Plan 查询失败，沿用上次快照' : '';
          console.log(`  ${p.name}: ✓ 余额 ${result.balance} ${result.currency}${planNote}`);
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

// 第 2 步: 全部有效；CC Switch 每次查询都会重新读取脚本配置。
if (!needRelogin) {
  console.log('\n全部 Cookie 有效；配置已同步，CC Switch 无需重启。');
  process.exit(0);
}

// 第 3 步: 有 Cookie 过期 —— 需要人工重新登录
// 计划任务是无人值守的，无法等待输入，此时只提示，不弹窗阻塞
if (!process.stdin.isTTY) {
  console.log('\n⚠ 有供应商需要重新登录，但当前为无人值守运行。');
  console.log('  请手动双击 2-login.bat 重新登录后，再运行 3-sync.bat。');
  if (anyOk) console.log('  （其余已成功刷新的供应商已写入 CC Switch 数据库。）');
  process.exit(needRelogin && !anyOk ? 1 : 0);
}

console.log('========================================');
console.log(' 正在检查供应商登录状态...');
console.log('========================================\n');

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext(
  existsSync(STATE_FILE) ? { storageState: STATE_FILE } : undefined
);
const page = await context.newPage();

// 检测页面是否被重定向到了登录页
function isLoginRedirect(url) {
  return /login|passport|signin|account\.xiaomi|sso/i.test(url);
}

let needManualLogin = false;

for (const p of config.providers) {
  try {
    await page.goto(p.homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000)); // 等待 SPA 路由跳转
    const url = page.url();
    if (isLoginRedirect(url)) {
      console.log(`  ${p.name}: ⚠ 需要登录`);
      needManualLogin = true;
    } else {
      console.log(`  ${p.name}: ✓ 已自动登录`);
    }
  } catch (e) {
    console.log(`  ${p.name}: ⚠ 页面加载异常`);
    needManualLogin = true;
  }
}

if (needManualLogin) {
  console.log('\n========================================');
  console.log(' 请在浏览器中完成登录，完成后回到这里按 Enter');
  console.log('========================================\n');
  await new Promise(resolve => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', resolve);
  });
} else {
  console.log('\n全部供应商已自动登录，无需手动操作。\n');
}

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
    const write = writeToCCSwitch(p, cookieHeader, result.tokenPlan);
    if (!write.ok) {
      console.log(`  ${p.name}: ✗ 写入 CC Switch 失败`);
      allOk = false;
      continue;
    }
    const planNote = result.tokenPlanError ? '；Token Plan 查询失败，沿用上次快照' : '';
    console.log(`  ${p.name}: ✓ 余额 ${result.balance} ${result.currency}${planNote}`);
  } catch (e) {
    console.log(`  ${p.name}: ✗ ${e.message}`);
    allOk = false;
  }
}

await browser.close();

if (allOk) {
  console.log('\n全部同步成功；CC Switch 无需重启，下次查询时会读取更新后的数据。');
} else {
  console.log('\n部分同步失败，请检查上方错误信息。');
}
