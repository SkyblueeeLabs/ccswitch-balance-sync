// playwright-cookie.mjs — 加载登录状态，查询所有供应商余额，写入 cc-switch
import { createRequire } from 'module';
import { execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'state.json');
const DISPLAY_MODE_FILE = join(__dirname, 'display-mode.json');
const DB = process.env.USERPROFILE + '\\.cc-switch\\cc-switch.db';
const config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));
let displayMode = config.usageDisplayMode === 'full' || config.longCatDisplayMode === 'full' ? 'full' : 'compact';
if (existsSync(DISPLAY_MODE_FILE)) {
  try {
    const savedMode = JSON.parse(readFileSync(DISPLAY_MODE_FILE, 'utf8')).mode;
    if (savedMode === 'compact' || savedMode === 'full') displayMode = savedMode;
  } catch {}
}
// 清理旧版本遗留的常驻代理；只匹配本项目代理脚本的完整路径。
function stopLegacyProxy() {
  const cleanupScript = join(__dirname, 'stop-legacy-proxy.ps1');
  if (!existsSync(cleanupScript)) return;
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cleanupScript,
    ], { stdio: 'ignore', windowsHide: true });
  } catch {
    console.log('⚠ 无法自动清理旧版代理；如果它仍在运行，请手动关闭旧的 balance-proxy.mjs 进程。');
  }
}

stopLegacyProxy();

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

// 按路径从对象中取值（如 "data.paygoBalance.primary.amount"）
function getByPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function parseMiMoTokenPlan(response, itemNames) {
  if (response?.code !== 0) {
    return { error: response?.msg || response?.message || `code=${response?.code}` };
  }
  const usage = response.data?.usage;
  if (usage == null || (Array.isArray(usage.items) && usage.items.length === 0)) {
    return { tokenPlan: null };
  }
  if (!Array.isArray(usage.items)) return { error: 'MiMo Token Plan 响应缺少 usage.items' };

  const names = itemNames || ['plan_total_token', 'compensation_total_token'];
  const items = usage.items.filter(item => names.includes(item?.name));
  if (items.length === 0) return { error: 'MiMo Token Plan 未返回已知额度字段' };

  let remaining = 0;
  let total = 0;
  let usedTotal = 0;
  for (const item of items) {
    const used = Number(item.used);
    const limit = Number(item.limit);
    if (!Number.isFinite(used) || !Number.isFinite(limit)) {
      return { error: `MiMo Token Plan 字段无效: ${item.name}` };
    }
    remaining += Math.max(0, limit - used);
    total += limit;
    usedTotal += used;
  }
  return { tokenPlan: remaining, tokenPlanInfo: { total, used: usedTotal } };
}

function parseLongCatTokenPacks(response) {
  if (response?.code !== 0) {
    return { error: response?.msg || response?.message || `code=${response?.code}` };
  }
  const lots = [response.data?.currentLot].concat(response.data?.otherLots || []).filter(Boolean);
  if (lots.length === 0) return { tokenPlan: null, tokenPlanInfo: null };

  const sumField = field => {
    const values = lots.map(lot => Number(lot[field])).filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  const expiryNotes = lots
    .map((lot, index) => lot.expireTime
      ? `${lots.length > 1 ? `包${index + 1} ` : ''}到期 ${lot.expireTime}`
      : '')
    .filter(Boolean);

  return {
    tokenPlan: lots.reduce((sum, lot) => sum + (Number(lot.remainingToken) || 0), 0),
    tokenPlanInfo: {
      total: sumField('totalToken'),
      used: sumField('consumedToken'),
      extra: expiryNotes.join('；'),
    },
  };
}

function formatTokenPlanNote(p, result) {
  if (!p.tokenPacksApiUrl && !p.tokenPlanApiUrl) return '';
  if (result.tokenPlanError) return '；TP 查询失败，沿用上次快照';
  if (result.tokenPlan == null) return '；Token Plan';
  return `；Token Plan 剩余 ¥ ${(result.tokenPlan / 10000).toFixed(1)}万`;
}

function formatCurrency(currency) {
  return currency === 'CNY' ? '¥' : currency;
}

// CC Switch 直接查询现金余额；Token Plan 使用最近一次同步到数据库的快照。
function buildScript(p, cookieHeader, tokenPlan, tokenPlanEmpty = false, tokenPlanInfo = null) {
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
    var displayCurrency = currency === "CNY" ? "¥" : currency;
    var tokenPlan = ${tokenPlan == null ? 'null' : JSON.stringify(tokenPlan)};
    var tokenPlanInfo = ${JSON.stringify(tokenPlanInfo || {})};
    var unit = displayCurrency;
    if (${(p.tokenPacksApiUrl || p.tokenPlanApiUrl) && displayMode === 'full' ? 'true' : 'false'} && tokenPlan == null && ${tokenPlanEmpty ? 'true' : 'false'}) {
      return [
        { isValid: true, planName: "现金余额", remaining: balance, unit: displayCurrency },
        { isValid: true, planName: "Token Plan", remaining: 0, unit: "tokens" }
      ];
    }
    if (tokenPlan != null) {
      unit = "¥ · " + (tokenPlan / 10000).toFixed(1) + "万";
    } else if (${tokenPlanEmpty ? 'true' : 'false'}) {
      unit = displayCurrency + " · TP:无额度";
    }
    if (${p.tokenPacksApiUrl || p.tokenPlanApiUrl ? 'true' : 'false'} && tokenPlan != null) {
      var tokenPlanUsage = {
        isValid: true,
        planName: ${JSON.stringify(p.tokenPlanApiUrl ? 'MiMo Token Plan' : 'Token Plan')},
        remaining: tokenPlan,
        unit: "tokens"
      };
      if (tokenPlanInfo.total != null && isFinite(Number(tokenPlanInfo.total))) tokenPlanUsage.total = Number(tokenPlanInfo.total);
      if (tokenPlanInfo.used != null && isFinite(Number(tokenPlanInfo.used))) tokenPlanUsage.used = Number(tokenPlanInfo.used);
      if (tokenPlanInfo.extra) tokenPlanUsage.extra = tokenPlanInfo.extra;
      if (${(p.tokenPacksApiUrl || p.tokenPlanApiUrl) && displayMode === 'full' ? 'true' : 'false'}) {
        return [
          { isValid: true, planName: "现金余额", remaining: balance, unit: displayCurrency },
          tokenPlanUsage
        ];
      }
      var tokenPlanDetails = [];
      if (tokenPlanInfo.total != null && isFinite(Number(tokenPlanInfo.total))) tokenPlanDetails.push("TP 总量 " + tokenPlanInfo.total + " tokens");
      if (tokenPlanInfo.used != null && isFinite(Number(tokenPlanInfo.used))) tokenPlanDetails.push("TP 已用 " + tokenPlanInfo.used + " tokens");
      if (tokenPlanInfo.extra) tokenPlanDetails.push(tokenPlanInfo.extra);
      return {
        isValid: true,
        planName: ${JSON.stringify(p.name)},
        remaining: balance,
        unit: "¥ · " + (tokenPlan / 10000).toFixed(1) + "万",
        extra: tokenPlanDetails.join(" · ")
      };
    }
    return {
      isValid: true,
      planName: ${JSON.stringify(p.name)},
      remaining: balance,
      unit: unit,
      extra: ""
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
  if (balance == null) return { error: '未找到余额字段' };

  // 查 token plan
  let tokenPlan = null;
  let tokenPlanError = null;
  let tokenPlanInfo = null;
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
      const parsed = parseLongCatTokenPacks(r2);
      tokenPlan = parsed.tokenPlan ?? null;
      tokenPlanInfo = parsed.tokenPlanInfo || null;
      tokenPlanError = parsed.error || null;
    } catch (e) {
      tokenPlanError = e.message;
    }
  }

  if (p.tokenPlanApiUrl) {
    try {
      const r3 = await page.evaluate(async ({ apiUrl, method }) => {
        const resp = await fetch(apiUrl, {
          method,
          headers: { 'Content-Type': 'application/json', 'X-Client-Language': 'zh', 'X-Requested-With': 'XMLHttpRequest' },
        });
        return { status: resp.status, body: await resp.json() };
      }, { apiUrl: p.tokenPlanApiUrl, method: p.tokenPlanMethod || 'GET' });
      if (r3.status < 200 || r3.status >= 300) {
        tokenPlanError = `HTTP ${r3.status}`;
      } else {
        const parsed = parseMiMoTokenPlan(r3.body, p.tokenPlanItemNames);
        tokenPlan = parsed.tokenPlan ?? null;
        tokenPlanInfo = parsed.tokenPlanInfo || null;
        tokenPlanError = parsed.error || null;
      }
    } catch (e) {
      tokenPlanError = e.message;
    }
  }

  return { balance, currency, tokenPlan, tokenPlanError, tokenPlanInfo };
}

// 获取 Cookie
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

// 写入 cc-switch 数据库
function writeToCCSwitch(p, cookieHeader, tokenPlan, tokenPlanError = null, tokenPlanInfo = null) {
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
  let effectiveTokenPlan = tokenPlan;
  if (effectiveTokenPlan == null && tokenPlanError && (p.tokenPacksApiUrl || p.tokenPlanApiUrl)) {
    const currentCode = meta.usage_script.code;
    const cached = typeof currentCode === 'string'
      ? currentCode.match(/var tokenPlan = (null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?);/)
      : null;
    if (cached && cached[1] !== 'null' && Number.isFinite(Number(cached[1]))) {
      effectiveTokenPlan = Number(cached[1]);
    }
  }
  const tokenPlanEmpty = Boolean((p.tokenPlanApiUrl || p.tokenPacksApiUrl) && !tokenPlanError && effectiveTokenPlan == null);
  const newCode = buildScript(p, cookieHeader, effectiveTokenPlan, tokenPlanEmpty, tokenPlanInfo);
  const changed = JSON.parse(row.meta).commonConfigEnabled !== false ||
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
    console.error(`  ✗ 写入失败: ${e.message}`);
    db.close();
    return { ok: false, reason: e.message };
  }
  db.close();
  return { ok: true, changed: true };
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
    const w = writeToCCSwitch(p, cookieHeader, result.tokenPlan, result.tokenPlanError, result.tokenPlanInfo);
    if (w.ok) {
      const planNote = formatTokenPlanNote(p, result);
      console.log(`  ✓ 余额: ${result.balance} ${formatCurrency(result.currency)}${planNote}`);
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
  console.log('\n全部同步成功；CC Switch 下次查询时会直接请求供应商余额接口。');
} else {
  console.log('\n部分同步失败，请检查上方错误信息。');
}
