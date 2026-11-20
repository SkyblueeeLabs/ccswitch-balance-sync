import { requestOptions } from './providers.mjs';

export function readPlanSnapshot(code, apiUrl) {
  if (typeof code !== 'string') return null;
  const url = JSON.stringify(apiUrl);
  if (!code.includes(`\n    "url": ${url},`) && !code.includes(`\n    url: ${url},`)) return null;

  const snapshot = code.match(/^    var planSnapshot = (.+);$/m);
  if (snapshot) return JSON.parse(snapshot[1]);

  // Preserve snapshots embedded by the previous versions.
  const remaining = code.match(/^    var tokenPlan = (null|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?);$/im);
  if (!remaining) return null;
  if (remaining[1] === 'null') {
    return code.includes('else if (true) {\n      unit = displayCurrency + " · TP:无额度";')
      ? { remaining: null } : null;
  }
  const info = code.match(/^    var tokenPlanInfo = (.+);$/m);
  return { ...(info ? JSON.parse(info[1]) : {}), remaining: Number(remaining[1]) };
}

export function buildUsageScript(provider, cookie, plan, displayMode) {
  const request = requestOptions(provider.apiUrl, provider.method, cookie, provider.method === 'POST' ? '{}' : undefined);
  return `({
  request: ${JSON.stringify(request, null, 2).replaceAll('\n', '\n  ')},
  extractor: function (response) {
    function pick(path) {
      if (path == null) return undefined;
      return path.split(".").reduce(function (value, key) {
        return value == null ? undefined : value[key];
      }, response);
    }
    var successCheck = ${JSON.stringify(provider.successCheck)};
    if (successCheck !== null && pick(successCheck) !== 0) {
      return { isValid: false, invalidMessage: "余额查询失败" };
    }
    var rawBalance = pick(${JSON.stringify(provider.balancePath)});
    if ((typeof rawBalance !== "number" && (typeof rawBalance !== "string" || !rawBalance.trim())) ||
        !isFinite(Number(rawBalance))) {
      return { isValid: false, invalidMessage: "余额字段缺失或格式无效" };
    }
    var currency = pick(${JSON.stringify(provider.currencyPath ?? null)});
    if (typeof currency !== "string" || !currency.trim()) currency = "CNY";
    var cash = {
      isValid: true,
      planName: ${JSON.stringify(provider.name)},
      remaining: Number(rawBalance),
      unit: currency === "CNY" ? "¥" : currency
    };
    var planSnapshot = ${JSON.stringify(plan)};
    if (planSnapshot == null) return cash;

    if (${displayMode === 'full'}) {
      cash.planName = "现金余额";
      var usage = {
        isValid: true,
        planName: ${JSON.stringify(provider.tokenPlanApiUrl ? 'MiMo Token Plan' : 'Token Plan')},
        remaining: planSnapshot.remaining == null ? 0 : planSnapshot.remaining,
        unit: "tokens"
      };
      if (planSnapshot.remaining == null) usage.planName = "Token Plan";
      if (planSnapshot.total != null) usage.total = planSnapshot.total;
      if (planSnapshot.used != null) usage.used = planSnapshot.used;
      if (planSnapshot.extra) usage.extra = planSnapshot.extra;
      return [cash, usage];
    }

    cash.unit += planSnapshot.remaining == null
      ? " · TP:无额度" : " · " + (planSnapshot.remaining / 10000).toFixed(1) + "万";
    var details = [];
    if (planSnapshot.total != null) details.push("TP 总量 " + planSnapshot.total + " tokens");
    if (planSnapshot.used != null) details.push("TP 已用 " + planSnapshot.used + " tokens");
    if (planSnapshot.extra) details.push(planSnapshot.extra);
    if (details.length) cash.extra = details.join(" · ");
    return cash;
  }
})`;
}
