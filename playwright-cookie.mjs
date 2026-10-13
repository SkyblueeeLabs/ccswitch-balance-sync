// playwright-cookie.mjs — 加载登录状态，查询所有供应商余额，写入 cc-switch
import { createRequire } from 'module';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, copyFileSync, existsSync } from 'node:fs';
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

// 重启 cc-switch
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

// 按路径从对象中取值（如 "data.paygoBalance.primary.amount"）
function getByPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// 构造余额查询脚本（extractor 内自带取值工具，避免生成超长表达式）
function buildScript(p, cookieHeader) {
  // extractor 收到的是接口原始响应体，data 不会被解包，
  // 所以这里必须保留完整路径：data.balance / data.paygoBalance.primary.amount
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

// 查询单个供应商余额
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

// 获取 Cookie
async function getCookieHeader(context, p) {
  const cookies = await context.cookies();
  return cookies
    .filter(c => c.domain.includes(p.cookieDomain))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

// 写入 cc-switch 数据库
function writeToCCSwitch(p, cookieHeader, balance, currency, status) {
  const db = new DatabaseSync(DB);
  const rows = db.prepare(
    "SELECT id, meta FROM providers WHERE name LIKE ? AND app_type='claude'"
  ).all(`%${p.matchName}%`);

  if (rows.length === 0) { db.close(); return { ok: false, reason: '未找到供应商' }; }

  // 优先选 claude 应用的
  const row = rows.find(r => JSON.parse(r.meta).app_type === 'claude') || rows[0];
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
    console.error(`  ✗ 写入失败: ${e.message}`);
    db.close();
    return { ok: false, reason: e.message };
  }
  db.close();
  return { ok: true };
}

// ==================== 主流程 ====================
console.log('正在加载登录状态...\n');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_FILE,
});
const page = await context.newPage();

let allOk = true;
for (const p of config.providers) {
  console.log(`--- ${p.name} ---`);
  try {
    const result = await queryProvider(page, p);
    if (result.error) {
      console.log(`  ✗ ${result.error}`);
      allOk = false;
      continue;
    }
    const cookieHeader = await getCookieHeader(context, p);
    const w = writeToCCSwitch(p, cookieHeader, result.balance, result.currency, result.status);
    if (w.ok) {
      console.log(`  ✓ 余额: ${result.balance} ${result.currency}`);
    } else {
      console.log(`  ✗ ${w.reason}`);
      allOk = false;
    }
  } catch (e) {
    console.log(`  ✗ 异常: ${e.message}`);
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
