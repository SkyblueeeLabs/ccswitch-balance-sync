import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { queryBalance } from '../lib/providers.mjs';
import { readPlanSnapshot } from '../lib/usage-script.mjs';

const root = new URL('../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('config.json', root)));

test('scopes cookies by host, path and expiry and rejects redirects without forwarding cookies', async t => {
  const provider = config.providers[0];
  const cookie = (name, domain, path = '/', expires = -1) => ({ name, value: 'fixture', domain, path, expires });
  const state = { cookies: [
    cookie('site', '.xiaomimimo.com'),
    cookie('api', 'platform.xiaomimimo.com', '/api'),
    cookie('unrelated', 'fake-xiaomimimo.com'),
    cookie('expired', 'platform.xiaomimimo.com', '/', 1),
    cookie('wrong-path', 'platform.xiaomimimo.com', '/api/v'),
    cookie('wrong-host', 'xiaomimimo.com'),
    cookie('subdomain', 'test.platform.xiaomimimo.com'),
  ] };
  const request = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, provider.apiUrl);
    assert.equal(options.headers.Cookie, 'api=fixture; site=fixture');
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://example.test/login' } });
  });
  assert.deepEqual(await queryBalance(provider, state), { error: 'HTTP 302', needsLogin: true });
  assert.equal(request.mock.callCount(), 1);
});

test('tells network, invalid response and authorization failures apart', async t => {
  const provider = config.providers[0];
  const state = { cookies: [{ name: 'sid', value: 'fixture', domain: '.xiaomimimo.com' }] };
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('private network details'); });
  assert.deepEqual(await queryBalance(provider, state), { error: '网络请求失败', needsLogin: false });
  request.mock.mockImplementation(async () => new Response('not JSON'));
  assert.deepEqual(await queryBalance(provider, state), { error: '接口未返回有效 JSON', needsLogin: false });
  request.mock.mockImplementation(async () => Response.json({ code: 0, data: { balance: false } }));
  assert.deepEqual(await queryBalance(provider, state), { error: '余额字段缺失或格式无效', needsLogin: false });
  request.mock.mockImplementation(async () => new Response(null, { status: 401 }));
  assert.deepEqual(await queryBalance(provider, state), { error: 'HTTP 401', needsLogin: true });
});

test('restores complete snapshots embedded by the old sync script', () => {
  const { apiUrl } = config.providers[1];
  const code = `({
  request: {
    url: "${apiUrl}",
    method: "POST"
  },
  extractor: function () {
    var tokenPlan = 60000;
    var tokenPlanInfo = {"total":90000,"used":30000,"extra":"到期 2027-01-01"};
  }
})`;
  assert.deepEqual(readPlanSnapshot(code, apiUrl), {
    remaining: 60_000, total: 90_000, used: 30_000, extra: '到期 2027-01-01',
  });
  assert.equal(readPlanSnapshot(code, config.providers[0].apiUrl), null);
});

test('reads CC Switch groups and login proxy routing from config.json', t => {
  const folder = mkdtempSync(join(tmpdir(), 'ccswitch-config-test-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  cpSync(new URL('lib', root), join(folder, 'lib'), { recursive: true });
  writeFileSync(join(folder, 'probe.mjs'),
    "import { loadConfig } from './lib/sync.mjs';\n" +
    'const config = loadConfig();\n' +
    'console.log(JSON.stringify({ appTypes: config.providers.map(p => p.appTypes), loginBrowserProxy: config.loginBrowserProxy }));\n');
  const run = config => {
    writeFileSync(join(folder, 'config.json'), JSON.stringify(config));
    return spawnSync(process.execPath, [join(folder, 'probe.mjs')], { encoding: 'utf8' });
  };
  const probe = provider => JSON.parse(run({ providers: [provider] }).stdout);
  const base = {
    name: 'Demo', matchName: 'Demo', cookieDomain: 'example.test',
    homeUrl: 'https://example.test/login', apiUrl: 'https://api.example.test/balance', balancePath: 'data.balance',
  };
  assert.deepEqual(probe(base), { appTypes: [['claude', 'claude-desktop']], loginBrowserProxy: 'direct' });
  assert.deepEqual(probe({ ...base, appType: 'codex' }).appTypes, [['codex']]);
  assert.deepEqual(probe({ ...base, appTypes: ['claude', 'claude', 'dsh'] }).appTypes, [['claude', 'dsh']]);
  assert.equal(JSON.parse(run({ providers: [base], loginBrowserProxy: 'system' }).stdout).loginBrowserProxy, 'system');
  assert.match(run({ providers: [{ ...base, appTypes: [] }] }).stderr, /appTypes 需要至少一个分组名/);
  assert.match(run({ providers: [{ ...base, appTypes: [''] }] }).stderr, /appTypes 需要非空分组名/);
  assert.match(run({ providers: [base], loginBrowserProxy: 'auto' }).stderr, /loginBrowserProxy 仅支持 direct 或 system/);
});

const mockFetch = `
globalThis.fetch = async (url, options) => {
  const { hostname, pathname } = new URL(url);
  if (!options.headers.Cookie.startsWith('fixture=')) throw new Error('missing test cookie');
  if (process.env.FIXTURE_FAILURE === 'cash' && hostname === 'longcat.chat') return new Response(null, { status: 401 });
  if (process.env.FIXTURE_FAILURE === 'plan' && (pathname.includes('token-packs') || pathname.includes('tokenPlan'))) return new Response(null, { status: 503 });
  const routes = {
    '/api/v1/balance': { balance: '0', currency: 'USD' },
    '/api/v1/tokenPlan/usage': { usage: { items: [{ name: 'plan_total_token', limit: 100000, used: 50000 }] } },
    '/api/pay/quota/metering/api-usage/summary': { paygoBalance: { primary: { amount: '3.5', currency: 'CNY' } } },
    '/api/pay/quota/metering/token-packs/summary': process.env.FIXTURE_FAILURE === 'empty'
      ? { currentLot: null, otherLots: [] }
      : { currentLot: { remainingToken: 60000, totalToken: 100000, consumedToken: 40000, expireTime: '2027-01-01' } },
  };
  if (!Object.hasOwn(routes, pathname)) throw new Error('unexpected test request');
  if (hostname === 'longcat.chat' && (options.method !== 'POST' || options.body !== '{}')) throw new Error('bad request');
  return Response.json({ code: 0, data: routes[pathname] });
};
`;

test('manual, scheduled and saved-login entry points update a WAL database safely', t => {
  const folder = mkdtempSync(join(tmpdir(), 'ccswitch-sync-test-'));
  const path = join(folder, 'cc-switch.db');
  const db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  });
  for (const file of ['lib', 'config.json', 'playwright-auto.mjs', 'playwright-cookie.mjs', 'playwright-login.mjs']) {
    cpSync(new URL(file, root), join(folder, file), { recursive: true });
  }
  writeFileSync(join(folder, 'state.json'), JSON.stringify({ origins: [], cookies: config.providers.map(provider => ({
    domain: `.${provider.cookieDomain}`, path: '/', expires: -1, name: 'fixture', value: provider.name,
  })) }));
  const modePath = join(folder, 'display-mode.json');
  writeFileSync(modePath, '{"mode":"full"}');
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, meta TEXT, PRIMARY KEY (id, app_type));
    INSERT INTO providers VALUES
      ('mimo', 'claude', 'MiMo', '{"commonConfigEnabled":true,"usage_script":{"autoQueryInterval":8}}'),
      ('mimo', 'claude-desktop', 'MiMo', '{"claudeDesktopMode":"chat","usage_script":{"autoQueryInterval":8}}'),
      ('mimo', 'codex', 'MiMo', '{"codex":true}'),
      ('mimo-alt', 'claude', 'MiMo backup', '{}'),
      ('mimo-alt', 'claude-desktop', 'MiMo Desktop backup', '{}'),
      ('longcat', 'claude', 'LongCat main', '{}');
  `);
  const run = (script, status, failure = '') => {
    const result = spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(mockFetch)}`, join(folder, script),
    ], { encoding: 'utf8', env: { ...process.env, CC_SWITCH_DB: path, FIXTURE_FAILURE: failure }, timeout: 10_000 });
    assert.equal(result.status, status, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
    return `${result.stdout}\n${result.stderr}`;
  };
  const backups = () => readdirSync(folder).filter(file => file.startsWith('cc-switch.backup-'));
  const row = (id, app = 'claude') => JSON.parse(db.prepare('SELECT meta FROM providers WHERE id=? AND app_type=?').get(id, app).meta);
  const usage = (id, app) => runInNewContext(row(id, app).usage_script.code);

  assert.match(run('playwright-cookie.mjs', 0), /2\/2/);
  assert.equal(row('mimo').commonConfigEnabled, true);
  assert.equal(row('mimo').usage_script.autoQueryInterval, 8);
  assert.deepEqual(row('mimo', 'codex'), { codex: true });
  assert.deepEqual(row('mimo-alt'), {});
  // One script is written to every configured group, keeping each record's own meta.
  assert.equal(row('mimo').usage_script.code, row('mimo', 'claude-desktop').usage_script.code);
  assert.equal(row('mimo', 'claude-desktop').claudeDesktopMode, 'chat');
  assert.equal(row('mimo', 'claude-desktop').usage_script.autoQueryInterval, 8);
  assert.deepEqual(row('mimo-alt', 'claude-desktop'), {});
  assert.equal(backups().length, 1);
  const backup = new DatabaseSync(join(folder, backups()[0]), { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(backup.prepare('SELECT count(*) AS count FROM providers').get().count, 6);
    assert.equal(backup.prepare("SELECT meta FROM providers WHERE id='longcat'").get().meta, '{}');
  } finally {
    backup.close();
  }
  const mimo = usage('mimo');
  const [cash, plan] = mimo.extractor({ code: 0, data: { balance: 0, currency: 'USD' } });
  assert.equal(cash.remaining, 0);
  assert.equal(cash.unit, 'USD');
  assert.equal(plan.remaining, 50_000);
  assert.equal(mimo.extractor({ code: 0, data: { balance: '' } }).isValid, false);
  assert.equal(usage('longcat').request.body, '{}');

  run('playwright-auto.mjs', 0);
  run('playwright-login.mjs', 0);
  assert.equal(backups().length, 1);
  // LongCat has no Claude Desktop record, so that group is skipped rather than failing the run.
  assert.match(run('playwright-auto.mjs', 0), /跳过 claude-desktop（无对应记录）/);
  // A record that lost its snapshot picks up the one kept by the other group.
  db.exec("UPDATE providers SET meta = '{\"usage_script\":{}}' WHERE id = 'mimo' AND app_type = 'claude-desktop'");
  assert.match(run('playwright-auto.mjs', 1, 'plan'), /沿用上次快照/);
  assert.deepEqual(readPlanSnapshot(row('longcat').usage_script.code, config.providers[1].apiUrl), {
    remaining: 60_000, total: 100_000, used: 40_000, extra: '到期 2027-01-01',
  });
  const restored = readPlanSnapshot(row('mimo', 'claude-desktop').usage_script.code, config.providers[0].apiUrl);
  assert.deepEqual(restored, readPlanSnapshot(row('mimo').usage_script.code, config.providers[0].apiUrl));
  assert.equal(restored.remaining, 50_000);
  writeFileSync(modePath, '{"mode":"compact"}');
  assert.match(run('playwright-auto.mjs', 1, 'cash'), /需要登录/);
  assert.equal(usage('mimo').extractor({ code: 0, data: { balance: 0, currency: 'USD' } }).unit, 'USD · 5.0万');
  assert.match(run('playwright-cookie.mjs', 0, 'empty'), /TP 无额度/);
  assert.deepEqual(readPlanSnapshot(row('longcat').usage_script.code, config.providers[1].apiUrl), { remaining: null });

  const lock = new DatabaseSync(join(folder, '.balance-sync.lock.db'));
  try {
    lock.exec('BEGIN IMMEDIATE');
    assert.match(run('playwright-auto.mjs', 2), /本次跳过/);
  } finally {
    lock.close();
  }

  const previousMiMo = row('mimo');
  const previousMiMoDesktop = row('mimo', 'claude-desktop');
  const previousLongCat = row('longcat');
  db.exec(`CREATE TRIGGER reject_longcat BEFORE UPDATE ON providers WHEN old.id = 'longcat'
    BEGIN SELECT RAISE(ABORT, 'fixture rejected the second write'); END;`);
  writeFileSync(modePath, '{"mode":"full"}');
  assert.match(run('playwright-auto.mjs', 1), /fixture rejected the second write/);
  assert.deepEqual(row('mimo'), previousMiMo);
  assert.deepEqual(row('mimo', 'claude-desktop'), previousMiMoDesktop);
  assert.deepEqual(row('longcat'), previousLongCat);
  db.exec("DROP TRIGGER reject_longcat; INSERT INTO providers VALUES ('longcat-alt', 'claude', 'LongCat duplicate', '{}')");
  assert.match(run('playwright-auto.mjs', 1), /匹配了多条记录/);
  assert.deepEqual(row('longcat'), previousLongCat);
  assert.deepEqual(row('longcat-alt'), {});
});
