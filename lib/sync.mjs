import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { updateDatabase } from './cc-switch-db.mjs';
import { inDomain, queryBalance, queryPlan } from './providers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const statePath = join(root, 'state.json');

function readJson(path) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(source.replace(/^\uFEFF/, ''));
  } catch {
    // JSON parse errors can include excerpts of the input, including Cookie values.
    throw new Error(`${path} 的 JSON 格式无效`);
  }
}

export function loadConfig() {
  const config = readJson(join(root, 'config.json'));
  if (!Array.isArray(config?.providers) || !config.providers.length) {
    throw new Error('config.json 需要至少一个 providers 配置');
  }
  const providers = config.providers.map((provider, index) => {
    const label = `providers[${index}]`;
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) throw new Error(`${label} 必须是对象`);
    const p = { method: 'GET', successCheck: 'code', tokenPlanMethod: 'GET',
      tokenPlanItemNames: ['plan_total_token', 'compensation_total_token'], ...provider };
    // appType is the legacy single-group spelling; the script goes to every group listed.
    p.appTypes = provider.appTypes ?? (provider.appType == null ? ['claude', 'claude-desktop'] : [provider.appType]);
    delete p.appType;
    if (!Array.isArray(p.appTypes) || !p.appTypes.length) throw new Error(`${label} 的 appTypes 需要至少一个分组名`);
    p.appTypes = [...new Set(p.appTypes.map(name => {
      if (typeof name !== 'string' || !name.trim()) throw new Error(`${label} 的 appTypes 需要非空分组名`);
      return name.trim();
    }))];
    const required = ['name', 'cookieDomain', 'balancePath', p.providerId ? 'providerId' : 'matchName'];
    for (const key of required) {
      if (typeof p[key] !== 'string' || !p[key].trim()) throw new Error(`${label} 的 ${key} 不能为空`);
    }
    p.cookieDomain = p.cookieDomain.trim().toLowerCase().replace(/^\./, '');
    p.loginUrl ??= p.homeUrl;
    for (const key of ['apiUrl', 'loginUrl', 'tokenPlanApiUrl', 'tokenPacksApiUrl']) {
      if (key.startsWith('token') && p[key] == null) continue;
      const url = typeof p[key] === 'string' ? URL.parse(p[key]) : null;
      if (!url || url.protocol !== 'https:' || url.username || url.password ||
          (key !== 'loginUrl' && !inDomain(url.hostname, p.cookieDomain))) {
        throw new Error(`${label} 的 ${key} 必须为有效 HTTPS 地址，API 必须属于 cookieDomain`);
      }
    }
    for (const key of ['method', 'tokenPlanMethod']) {
      p[key] = typeof p[key] === 'string' ? p[key].toUpperCase() : '';
      if (!['GET', 'POST'].includes(p[key])) throw new Error(`${label} 的 ${key} 仅支持 GET 或 POST`);
    }
    if (p.tokenPlanApiUrl && p.tokenPacksApiUrl) throw new Error(`${label} 只能配置一种套餐接口`);
    if (p.tokenPlanApiUrl && (!Array.isArray(p.tokenPlanItemNames) || !p.tokenPlanItemNames.length ||
        !p.tokenPlanItemNames.every(name => typeof name === 'string' && name.trim()))) {
      throw new Error(`${label} 的 tokenPlanItemNames 需要至少一个有效名称`);
    }
    for (const key of ['successCheck', 'currencyPath']) {
      if (p[key] != null && (typeof p[key] !== 'string' || !p[key].trim())) {
        throw new Error(`${label} 的 ${key} 需要字段路径或 null`);
      }
    }
    return p;
  });
  const loginBrowserProxy = config.loginBrowserProxy ?? 'direct';
  if (!['direct', 'system'].includes(loginBrowserProxy)) {
    throw new Error('loginBrowserProxy 仅支持 direct 或 system');
  }
  return { ...config, providers, loginBrowserProxy };
}

export function loadState(recover = false) {
  const empty = { cookies: [], origins: [] };
  try {
    const state = readJson(statePath);
    if (state === undefined) return empty;
    if (!Array.isArray(state?.cookies) || (state.origins != null && !Array.isArray(state.origins))) {
      throw new Error('state.json 的登录状态格式无效');
    }
    return { ...state, origins: state.origins ?? [] };
  } catch (error) {
    if (!recover) throw new Error(`${error.message}。请运行 2-login.bat 恢复登录状态。`);
    console.warn(`${error.message}。验证新登录后会保存可用状态。`);
    return empty;
  }
}

export function saveState(state) {
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, statePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readDisplayMode(config) {
  try {
    const displayMode = readJson(join(root, 'display-mode.json'))?.mode;
    if (displayMode === 'full' || displayMode === 'compact') return displayMode;
  } catch {
    console.warn('无法读取 display-mode.json，已使用配置中的默认模式。');
  }
  return (config.usageDisplayMode ?? config.longCatDisplayMode) === 'full' ? 'full' : 'compact';
}

export async function syncBalances(config, state, balances) {
  const entries = await Promise.all(config.providers.map(async (provider, index) => {
    const balance = balances?.[index] ?? await queryBalance(provider, state);
    const plan = balance.error ? {} : await queryPlan(provider, state);
    return { provider, ...balance, ...plan };
  }));
  const databasePath = resolve(process.env.CC_SWITCH_DB || join(homedir(), '.cc-switch', 'cc-switch.db'));
  const results = updateDatabase(databasePath, entries, () => readDisplayMode(config));

  let successful = 0;
  for (const { provider, error, needsLogin, balance, currency, plan, planError, written, skipped } of results) {
    if (error) {
      console.error(`  ${provider.name}：${needsLogin ? '需要登录 · ' : ''}${error}`);
      continue;
    }
    const cash = `余额 ${balance} ${currency === 'CNY' ? '¥' : currency}`;
    const planNote = plan?.remaining == null ? (plan ? ' · TP 无额度' : '') : ` · TP 剩余 ${plan.remaining} tokens`;
    const updated = written.filter(item => item.changed).map(item => item.appType);
    const stale = written.filter(item => !item.changed).map(item => item.appType);
    const notes = [];
    if (updated.length) notes.push(`${updated.join('、')} 已更新`);
    if (stale.length) notes.push(`${stale.join('、')} 配置已是最新`);
    if (skipped.length) notes.push(`跳过 ${skipped.join('、')}（无对应记录）`);
    console.log(`  ${provider.name}：${cash}${planNote} · ${notes.join(' · ')}`);
    if (planError) {
      console.warn(`    套餐查询失败（${planError}） · ${plan ? '沿用上次快照' : '暂无可用快照'}`);
    } else {
      successful += 1;
    }
  }
  if (results.some(result => result.needsLogin)) console.log('请运行 2-login.bat 恢复需要登录的供应商。');
  console.log(`\n同步完成，${successful}/${results.length} 家供应商完整成功。`);
  return successful === results.length ? 0 : 1;
}

export async function runExclusive(action = async config => syncBalances(config, loadState())) {
  try {
    const lock = new DatabaseSync(join(root, '.balance-sync.lock.db'));
    try {
      try {
        // No busy wait: the other process may be waiting for a browser login.
        lock.exec('BEGIN IMMEDIATE');
      } catch (error) {
        if (error.errcode !== 5) throw error;
        console.log('已有登录或同步正在运行，本次跳过。');
        process.exitCode = 2;
        return;
      }
      process.exitCode = await action(loadConfig());
    } finally {
      lock.close();
    }
  } catch (error) {
    console.error(`同步未完成：${error.message}`);
    process.exitCode = 1;
  }
}
