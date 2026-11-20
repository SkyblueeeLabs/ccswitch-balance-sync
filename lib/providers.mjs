const headers = {
  'Content-Type': 'application/json',
  'X-Client-Language': 'zh',
  'X-Requested-With': 'XMLHttpRequest',
};

export function requestOptions(url, method, cookie, body) {
  return { url, method, headers: { ...headers, Cookie: cookie }, ...(body === undefined ? {} : { body }) };
}

export function inDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function cookieHeader(state, provider, url) {
  const { hostname, pathname } = new URL(url);
  const now = Date.now() / 1000;
  return state.cookies
    .filter(cookie => {
      if (typeof cookie?.domain !== 'string' || cookie.partitionKey) return false;
      const domain = cookie.domain.toLowerCase().replace(/^\./, '');
      if (!inDomain(domain, provider.cookieDomain)) return false;
      if (cookie.domain.startsWith('.') ? !inDomain(hostname, domain) : hostname !== domain) return false;
      if (Number.isFinite(cookie.expires) && cookie.expires >= 0 && cookie.expires <= now) return false;
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name ?? '') ||
          typeof cookie.value !== 'string' || /[\x00-\x1f\x7f;]/.test(cookie.value)) return false;
      const path = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
      return pathname === path || pathname.startsWith(path.endsWith('/') ? path : `${path}/`);
    })
    .sort((left, right) => (right.path?.length ?? 1) - (left.path?.length ?? 1))
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function requestJson(state, provider, url, method, body, timeout) {
  const cookie = cookieHeader(state, provider, url);
  if (!cookie) throw new QueryError('缺少适用于接口的有效 Cookie', true);
  const request = requestOptions(url, method, cookie, body);
  try {
    const response = await fetch(url, {
      method, headers: request.headers, body,
      redirect: 'manual', signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      const loginRedirect = response.status >= 300 && response.status < 400 &&
        /login|passport|sign[-_]?in|account\.xiaomi|sso/i.test(location ?? '');
      throw new QueryError(`HTTP ${response.status}`, loginRedirect || [401, 403].includes(response.status));
    }
    return { cookie, data: await response.json() };
  } catch (error) {
    if (error instanceof QueryError) throw error;
    if (error.name === 'TimeoutError') throw new QueryError('请求超时');
    if (error instanceof SyntaxError) throw new QueryError('接口未返回有效 JSON');
    throw new QueryError('网络请求失败');
  }
}

class QueryError extends Error {
  constructor(message, needsLogin = false) {
    super(message);
    this.needsLogin = needsLogin;
  }
}

function getByPath(value, path) {
  return path?.split('.').reduce((item, key) => item?.[key], value);
}

function finiteNumber(value) {
  if (typeof value === 'number' || (typeof value === 'string' && value.trim())) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function checkResult(data, path) {
  if (path == null) return;
  const code = getByPath(data, path);
  if (code === 0) return;
  const label = typeof code === 'number' ? `业务状态码 ${code}` : '接口返回了未知业务状态';
  const message = data?.msg ?? data?.message;
  const needsLogin = [401, 403, '401', '403'].includes(code) ||
    (typeof message === 'string' && /未登录|请.{0,3}登录|登录.{0,4}(失效|过期)|unauthori[sz]ed|not logged in|login required/i.test(message));
  throw new QueryError(label, needsLogin);
}

export async function queryBalance(provider, state) {
  try {
    const body = provider.method === 'POST' ? '{}' : undefined;
    const { cookie, data } = await requestJson(state, provider, provider.apiUrl, provider.method, body, 15_000);
    checkResult(data, provider.successCheck);
    const balance = finiteNumber(getByPath(data, provider.balancePath));
    if (balance === null) throw new QueryError('余额字段缺失或格式无效');
    const currency = getByPath(data, provider.currencyPath);
    return { cookie, balance, currency: typeof currency === 'string' && currency.trim() ? currency : 'CNY' };
  } catch (error) {
    if (!(error instanceof QueryError)) throw error;
    return { error: error.message, needsLogin: error.needsLogin };
  }
}

function parseMiMoPlan(data, itemNames) {
  const usage = data.data?.usage;
  if (!Object.hasOwn(data, 'data') || (data.data != null && !Object.hasOwn(data.data, 'usage'))) {
    throw new QueryError('套餐响应缺少 usage');
  }
  if (usage == null) return { remaining: null };
  if (!Array.isArray(usage.items)) throw new QueryError('套餐响应缺少 usage.items');
  if (usage.items.length === 0) return { remaining: null };

  const items = usage.items.filter(item => itemNames.includes(item?.name));
  if (items.length === 0) throw new QueryError('套餐响应没有已配置的额度项');
  const plan = { remaining: 0, total: 0, used: 0 };
  for (const item of items) {
    const used = finiteNumber(item.used);
    const limit = finiteNumber(item.limit);
    if (used == null || limit == null || used < 0 || limit < 0) throw new QueryError('套餐额度格式无效');
    plan.remaining += Math.max(0, limit - used);
    plan.total += limit;
    plan.used += used;
  }
  return plan;
}

function parseLongCatPlan(data) {
  const packs = data.data;
  if (packs === null) return { remaining: null };
  if (!packs || (!Object.hasOwn(packs, 'currentLot') && !Object.hasOwn(packs, 'otherLots'))) {
    throw new QueryError('套餐响应缺少额度字段');
  }
  if (packs.otherLots != null && !Array.isArray(packs.otherLots)) throw new QueryError('套餐列表格式无效');
  const lots = [packs.currentLot, ...(packs.otherLots ?? [])].filter(lot => lot != null);
  if (lots.length === 0) return { remaining: null };
  const remaining = lots.map(lot => finiteNumber(lot.remainingToken));
  if (remaining.some(value => value == null || value < 0)) throw new QueryError('套餐剩余额度格式无效');
  const sumField = field => {
    const values = lots.map(lot => finiteNumber(lot[field]));
    return values.every(value => value != null && value >= 0) ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  const expiryNotes = lots.flatMap((lot, index) => (typeof lot.expireTime === 'string' || Number.isFinite(lot.expireTime)) && lot.expireTime
    ? [`${lots.length > 1 ? `包${index + 1} ` : ''}到期 ${lot.expireTime}`] : []);

  return {
    remaining: remaining.reduce((sum, value) => sum + value, 0),
    total: sumField('totalToken'),
    used: sumField('consumedToken'),
    extra: expiryNotes.join('；'),
  };
}

export async function queryPlan(provider, state) {
  const { tokenPlanApiUrl, tokenPacksApiUrl, tokenPlanMethod, tokenPlanItemNames } = provider;
  const url = tokenPlanApiUrl ?? tokenPacksApiUrl;
  if (!url) return {};
  try {
    const { data } = await requestJson(state, provider, url, tokenPlanApiUrl ? tokenPlanMethod : 'POST',
      tokenPlanApiUrl ? undefined : '{}', 10_000);
    checkResult(data, 'code');
    const plan = tokenPlanApiUrl ? parseMiMoPlan(data, tokenPlanItemNames) : parseLongCatPlan(data);
    if ([plan.remaining, plan.total, plan.used].some(value => value != null && !Number.isFinite(value))) {
      throw new QueryError('套餐额度超出可用范围');
    }
    return { plan };
  } catch (error) {
    if (!(error instanceof QueryError)) throw error;
    return { planError: error.message };
  }
}
