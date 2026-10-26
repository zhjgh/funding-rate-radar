/**
 * 多数据源适配层
 * ------------------------------------------------------------
 * 并发请求多个交易所公开接口，谁先返回有效数据就用谁；全部失败则进入熔断窗口，
 * 直接返回本地降级数据，不再每次都去等一遍超时。
 *
 *   1. Bybit  v5/market/tickers?category=linear   —— 一次返回全市场，且带 fundingIntervalHour
 *   2. Binance fapi/v1/premiumIndex + ticker/24hr —— 需要两份数据拼，结算间隔按 8h
 *
 * 为什么要多源：Binance 有区域限制，部署到云端后经常超时；
 * Bybit 的线性合约接口一次请求就能拿到 fundingRate / nextFundingTime / turnover24h，
 * 数据更全，接口更少。
 */

const https = require('https');

const CACHE_TTL = 60 * 1000;
let cache = { at: 0, data: null };

/**
 * 最小日成交额门槛（USDT）
 * 低流动性合约的费率极易被单笔订单打飞，年化几百个点也不代表任何东西，
 * 摆在榜单前面只会污染判断。过滤掉它们是交易常识，不是技术处理。
 */
const MIN_QUOTE_VOLUME = 10_000_000;

/** 入榜合约数量上限（按日成交额取前 N） */
const TOP_N = 120;

/** 内置 https 抓 JSON，不依赖 fetch，Node 14+ 均可运行 */
function fetchJSON(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('响应不是合法 JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/**
 * 统一归一化
 * 年化按「实际结算间隔」算：一天 24/intervalHour 次，一年 365 天
 * 这点很重要 —— 永续合约有 1h / 4h / 8h 三种结算周期，
 * 固定用 8h 去乘会把 4h 结算合约的年化算少一半。
 */
function toItem({ symbol, rate, intervalHour, markPrice, indexPrice, volume, nextFundingTime }) {
  const perYear = (24 / intervalHour) * 365;
  return {
    symbol,
    rate,                                  // 当期费率（小数）
    intervalHour,                          // 结算间隔（小时）
    annualized: rate * perYear * 100,      // 年化（%）
    markPrice,
    indexPrice,
    quoteVolume: volume,                   // 日成交额（USDT）
    nextFundingTime,
  };
}

/** Bybit：一次请求拿全市场 */
async function loadBybit() {
  const res = await fetchJSON('https://api.bybit.com/v5/market/tickers?category=linear', PROVIDER_TIMEOUT);
  if (res.retCode !== 0) throw new Error(res.retMsg || 'Bybit 返回异常');

  return res.result.list
    .filter((x) => x.symbol.endsWith('USDT') && Number(x.nextFundingTime) > 0)
    .map((x) =>
      toItem({
        symbol: x.symbol,
        rate: Number(x.fundingRate),
        intervalHour: Number(x.fundingIntervalHour) || 8,
        markPrice: Number(x.markPrice),
        indexPrice: Number(x.indexPrice),
        volume: Number(x.turnover24h),
        nextFundingTime: Number(x.nextFundingTime),
      })
    );
}

/** Binance：费率 + 成交量两份数据拼（接口不含结算间隔，按 8h 处理） */
async function loadBinance() {
  const [premium, tickers] = await Promise.all([
    fetchJSON('https://fapi.binance.com/fapi/v1/premiumIndex', PROVIDER_TIMEOUT),
    fetchJSON('https://fapi.binance.com/fapi/v1/ticker/24hr', PROVIDER_TIMEOUT).catch(() => null),
  ]);

  const volumeMap = {};
  if (Array.isArray(tickers)) {
    tickers.forEach((t) => {
      volumeMap[t.symbol] = t.quoteVolume;
    });
  }

  return premium
    .filter((x) => x.symbol.endsWith('USDT') && Number(x.nextFundingTime) > 0)
    .map((x) =>
      toItem({
        symbol: x.symbol,
        rate: Number(x.lastFundingRate),
        intervalHour: 8,
        markPrice: Number(x.markPrice),
        indexPrice: Number(x.indexPrice),
        volume: Number(volumeMap[x.symbol] || 0),
        nextFundingTime: Number(x.nextFundingTime),
      })
    );
}

const PROVIDERS = [
  ['bybit', loadBybit],
  ['binance', loadBinance],
];

/**
 * 数据源请求超时（毫秒）
 * 部署在云上时交易所接口基本连不通，超时值直接决定首屏要等多久。
 * 8 秒 × 2 个源串行 = 16 秒，页面会一直停在「加载中」——
 * 所以这里收紧到 3 秒，并且改成并发竞速（见 loadFirstAvailable）。
 */
const PROVIDER_TIMEOUT = 3000;

/**
 * 熔断窗口（毫秒）
 * 一旦确认「所有数据源都不可达」，在接下来 5 分钟里不再尝试，
 * 直接返回降级数据。否则每 30 秒一次的前端轮询会反复走一遍超时路径，
 * 每次都卡好几秒。这是典型的熔断器（circuit breaker）用法。
 */
const FAIL_COOLDOWN = 5 * 60 * 1000;
let cooldownUntil = 0;

/** 过滤低流动性 + 取最活跃 N 个 + 按年化排序 */
function rank(list) {
  const valid = list.filter((x) => Number.isFinite(x.rate) && x.nextFundingTime > 0);
  const liquid = valid.filter((x) => x.quoteVolume >= MIN_QUOTE_VOLUME);
  const base = liquid.length >= 10 ? liquid : valid; // 门槛过严时退回全量，避免空榜
  return base
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, TOP_N)
    .sort((a, b) => b.annualized - a.annualized);
}

/**
 * 并发竞速：两个源同时发请求，谁先返回有效数据就用谁。
 *
 * 之前是 for 循环串行 await，第一路超时之后才试第二路，最坏情况等满
 * 「源数量 × 超时」。改成并发之后，最坏情况只等于「单个超时」。
 * 注意仍然是并发但**不完全对等**：先成功的胜出即可，不做额外加权 ——
 * 两个源的数据结构在 toItem 里已经归一化，谁先到都能用。
 */
function loadFirstAvailable() {
  return new Promise((resolve, reject) => {
    const errors = [];
    let pending = PROVIDERS.length;

    PROVIDERS.forEach(([name, loader]) => {
      loader()
        .then((raw) => {
          const list = rank(raw);
          if (!list.length) throw new Error('返回数据为空');
          resolve({ name, list });
        })
        .catch((err) => {
          errors.push(`${name}: ${err.message}`);
          if (--pending === 0) reject(Object.assign(new Error('全部数据源不可达'), { errors }));
        });
    });
  });
}

/** 汇总指标：给顶部指标卡用 */
function summarize(list) {
  if (!list.length) return null;
  const values = list.map((x) => x.annualized).sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return {
    count: list.length,
    max: values[values.length - 1],
    min: values[0],
    median: values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2,
    positiveCount: list.filter((x) => x.annualized > 0).length,
  };
}

/**
 * 对外唯一入口
 * 返回 { source, fetchedAt, cached, list, summary }
 * source = 'bybit' | 'binance' 表示实时，'snapshot' / 'mock' 表示降级
 */
async function getFundingSnapshot() {
  const now = Date.now();

  // 1. 有未过期的缓存，直接返回（实时数据也缓存 60 秒，降级数据同样缓存）
  if (cache.data && now - cache.at < CACHE_TTL) {
    return { ...cache.data, cached: true };
  }

  // 2. 熔断窗口内不再打交易所接口 —— 这是之前每次都要卡十几秒的根因
  if (now < cooldownUntil) {
    const remain = Math.ceil((cooldownUntil - now) / 1000);
    const fallback = loadFallback([`数据源不可达（熔断中，${remain}s 后重试）`]);
    cache = { at: now, data: fallback };
    return fallback;
  }

  try {
    const { name, list } = await loadFirstAvailable();
    const snapshot = {
      source: name,
      fetchedAt: new Date().toISOString(),
      cached: false,
      list,
      summary: summarize(list),
    };
    cache = { at: now, data: snapshot };
    cooldownUntil = 0; // 恢复正常
    return snapshot;
  } catch (err) {
    // 3. 全部失败：进入熔断窗口，并把降级结果写进缓存，
    //    保证后面 60 秒内的请求都是毫秒级返回
    cooldownUntil = Date.now() + FAIL_COOLDOWN;
    const fallback = loadFallback(err.errors || [err.message]);
    cache = { at: now, data: fallback };
    return fallback;
  }
}

/**
 * 降级数据加载
 * 优先用 snapshot.json（构建时抓下来的真实行情），没有才用内置 mock。
 *
 * 快照里的 nextFundingTime 是抓取当时的绝对时间戳，放着不动很快就会变成过去时间，
 * 倒计时会出现负数。所以这里按结算周期重新推到「下一个 UTC 整点结算时刻」——
 * 交易所本来就是按 UTC 整点结算的，这样推算出来的时间与真实结算点一致。
 */
function loadFallback(errors) {
  let data;
  try {
    data = require('./snapshot.json');
  } catch (e) {
    data = require('./mock.json');
  }

  const now = Date.now();
  const list = (data.list || [])
    .map((item) => {
      const hours = item.intervalHour || 8;
      const period = hours * 3600 * 1000;
      return {
        ...item,
        intervalHour: hours,
        annualized: item.rate * (24 / hours) * 365 * 100,
        nextFundingTime: Math.ceil(now / period) * period,
      };
    })
    .sort((a, b) => b.annualized - a.annualized);

  const isSnapshot = data.snapshotAt !== undefined;

  return {
    source: isSnapshot ? 'snapshot' : 'mock',
    provider: data.source || null, // 快照来自哪个交易所，前端用来显示「Bybit 快照」
    snapshotAt: data.snapshotAt || null,
    note: data.note,
    fetchedAt: new Date().toISOString(),
    cached: false,
    fallbackReason: errors.join(' | '),
    list,
    summary: summarize(list),
  };
}

module.exports = { getFundingSnapshot, toItem, rank, summarize };
