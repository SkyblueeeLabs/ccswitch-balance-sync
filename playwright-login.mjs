import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { inDomain, queryBalance } from './lib/providers.mjs';
import { loadState, runExclusive, saveState, syncBalances } from './lib/sync.mjs';

async function loadChromium() {
  try {
    return (await import('playwright')).chromium;
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    // Upgrades can keep using the npm global installation made by the old installer.
    const appdata = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    const require = createRequire(import.meta.url);
    try {
      return require(join(appdata, 'npm', 'node_modules', 'playwright')).chromium;
    } catch (fallbackError) {
      if (fallbackError.code !== 'MODULE_NOT_FOUND') throw fallbackError;
      throw new Error('找不到 Playwright，请运行 1-install.bat 安装。');
    }
  }
}

function mergeVerifiedState(previous, candidate, providers) {
  const matches = host => typeof host === 'string' && providers.some(
    provider => inDomain(host.toLowerCase().replace(/^\./, ''), provider.cookieDomain),
  );
  const hasOrigin = item => matches(URL.parse(item?.origin)?.hostname);
  return {
    ...previous,
    cookies: [...previous.cookies.filter(item => !matches(item?.domain)), ...candidate.cookies.filter(item => matches(item.domain))],
    origins: [...previous.origins.filter(item => !hasOrigin(item)), ...candidate.origins.filter(hasOrigin)],
  };
}

function shareCookieDomain(left, right) {
  return inDomain(left.cookieDomain, right.cookieDomain) || inDomain(right.cookieDomain, left.cookieDomain);
}

async function updateLogin(config, state, balances, pending) {
  if (!process.stdin.isTTY) throw new Error('重新登录需要交互式终端，请双击 2-login.bat。');
  const chromium = await loadChromium();
  let browser;
  try {
    // Only this browser run goes direct, so a slow global proxy cannot hold up the
    // login pages. The machine's proxy settings stay as they are. Note that Chromium
    // ignores --no-proxy-server on Windows, so the direct route has to be explicit.
    browser = await chromium.launch({
      headless: false,
      ...(config.loginBrowserProxy === 'system' ? {} : { args: ['--proxy-server=direct://'] }),
    });
  } catch (error) {
    if (error.message.includes("Executable doesn't exist")) {
      throw new Error('找不到 Chromium，请运行 1-install.bat 安装浏览器。');
    }
    throw new Error('Chromium 启动失败，请检查当前环境是否允许运行 Playwright 浏览器。');
  }

  try {
    const context = await browser.newContext({ storageState: state }).catch(() => {
      throw new Error('无法加载浏览器登录状态，请检查 state.json 的格式。');
    });
    await Promise.all(pending.map(async ({ provider }) => {
      const page = await context.newPage();
      console.log(`正在打开 ${provider.name} 的登录页面…`);
      try {
        await page.goto(provider.loginUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      } catch {
        console.warn(`  ${provider.name}：页面加载未完成，可在浏览器中重试。`);
      }
    }));

    console.log('\n登录完成后回到此窗口按 Enter。');
    const input = createInterface({ input: process.stdin });
    try {
      const { done } = await input[Symbol.asyncIterator]().next();
      if (done) throw new Error('登录已取消。');
    } finally {
      input.close();
    }

    const candidate = await context.storageState().catch(() => {
      throw new Error('无法读取浏览器登录状态，请保持浏览器开启。');
    });
    const checks = await Promise.all(pending.map(async item => ({
      ...item, balance: await queryBalance(item.provider, candidate),
    })));
    const failed = checks.filter(item => item.balance.error);
    const verified = checks.filter(({ provider, balance }) =>
      !balance.error && !failed.some(({ provider: other }) => shareCookieDomain(provider, other)));
    if (verified.length) {
      state = mergeVerifiedState(state, candidate, verified.map(({ provider }) => provider));
      saveState(state);
      console.log(`已保存验证通过的登录状态（${verified.map(({ provider }) => provider.name).join('、')}）。`);
    }
    for (const { provider, balance } of failed) {
      console.warn(`  ${provider.name}：新登录验证失败（${balance.error}）。`);
    }
    const updated = await Promise.all(config.providers.map((provider, index) => {
      const check = verified.find(item => item.index === index);
      if (check) return check.balance;
      if (verified.some(({ provider: other }) => shareCookieDomain(provider, other))) return queryBalance(provider, state);
      return balances[index];
    }));
    return { state, balances: updated, incomplete: verified.length !== pending.length };
  } finally {
    await browser.close();
  }
}

await runExclusive(async config => {
  let state = loadState(true);
  let balances = await Promise.all(config.providers.map(provider => queryBalance(provider, state)));
  const force = process.argv.includes('--force');
  const pending = config.providers.map((provider, index) => ({ provider, index }))
    .filter(({ index }) => force || balances[index].needsLogin);
  let incomplete = false;
  if (pending.length) {
    try {
      ({ state, balances, incomplete } = await updateLogin(config, state, balances, pending));
    } catch (error) {
      console.error(`登录未完成：${error.message}`);
      incomplete = true;
    }
  }
  const exitCode = await syncBalances(config, state, balances);
  return incomplete ? 1 : exitCode;
});
