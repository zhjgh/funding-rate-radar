/**
 * 数据源适配层
 * ------------------------------------------------------------
 * 唯一数据源：Binance USDT-M 永续合约 premiumIndex 接口
 *   GET https://fapi.binance.com/fapi/v1/premiumIndex
 *
 * 这个接口一次性返回全市场永续合约的：
 *   - lastFundingRate  当前资金费率（小数，如 0.0001 = 0.01%）
 *   - nextFundingTime  下次结算时间戳（毫秒）
 *   - markPrice        标记价格
 *   - indexPrice       现货指数价格
 *
 * 本层做三件事：抓取 → 归一化 → 缓存（失败时降级到本地快照）
 */

const https = require('https');

// 资金费率 8 小时结算一次，60 秒缓存完全够用，避免反复打第三方接口
const CACHE_TTL = 60 * 1000;
let cache = { at: 0, data: null };

/**
 * 最小日成交额门槛（USDT）
 * 低流动性合约的费率极易被单笔订单打飞，年化几百个点也不代表任何东西，
 * 摆在榜单前面只会污染判断。过滤掉它们是交易常识，不是技术处理。
 */
const MIN_QUOTE_VOLUME = 10_000_000;

/**
 * 入榜合约数量上限（按日成交额取前 N）
 * 886 个 USDT 合约里有一堆法币汇率对（USDBRL 等）和刚上线的小币，
 * 它们的费率不反映真实市场情绪。先按成交额筛出最活跃的一批，再按费率排序。
 */
const TOP_N = 120;

/**
 * 资金费率 → 年化
 * 每 8 小时收一次，一天 3 次，一年 365 天
 * 注意：这是单利简单年化，业内通用的粗算口径，不是复利
 */
function annualize(rate) {
  return rate * 3 * 365 * 100; // 转成百分数
}

/** 用内置 https 抓 JSON，不依赖 fetch，Node 14+ 均可运行 */
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
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

/** 原始响应 → 前端可直接用的结构 */
function normalize(raw, volumeMap = {}) {
  return raw
    .filter((item) => item.symbol.endsWith('USDT')) // 只看 USDT 本位，避免混入币本位
    .map((item) => {
      const rate = Number(item.lastFundingRate);
      return {
        symbol: item.symbol,
        rate,                                  // 当期费率（小数）
        annualized: annualize(rate),           // 年化（%）
        markPrice: Number(item.markPrice),
        indexPrice: Number(item.indexPrice),
        quoteVolume: Number(volumeMap[item.symbol] || 0),
        nextFundingTime: Number(item.nextFundingTime),
      };
    })
    .filter((item) => Number.isFinite(item.rate) && item.nextFundingTime > 0)
    // 成交额不足的合约不参与排行；拿不到成交量数据时不过滤，保证可用性
    .filter((item) => Object.keys(volumeMap).length === 0 || item.quoteVolume >= MIN_QUOTE_VOLUME)
    .sort((a, b) => b.quoteVolume - a.quoteVolume) // 先按活跃度取前 N
    .slice(0, TOP_N)
    .sort((a, b) => b.annualized - a.annualized); // 再按年化排序
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
 * source = 'binance' 表示实时，'mock' 表示降级到本地快照
 */
async function getFundingSnapshot() {
  const now = Date.now();

  if (cache.data && now - cache.at < CACHE_TTL) {
    return { ...cache.data, cached: true };
  }

  try {
    // 并发拿两份数据：当前费率 + 24h 成交量（后者用来过滤低流动性合约）
    // 成交量接口失败不阻断主流程，降级为"不过滤"
    const [premium, tickers] = await Promise.all([
      fetchJSON('https://fapi.binance.com/fapi/v1/premiumIndex'),
      fetchJSON('https://fapi.binance.com/fapi/v1/ticker/24hr').catch(() => null),
    ]);

    const volumeMap = {};
    if (Array.isArray(tickers)) {
      tickers.forEach((t) => {
        volumeMap[t.symbol] = t.quoteVolume;
      });
    }

    const list = normalize(premium, volumeMap);
    if (!list.length) throw new Error('返回数据为空');

    const usdtTotal = premium.filter((x) => x.symbol.endsWith('USDT')).length;

    const snapshot = {
      source: 'binance',
      fetchedAt: new Date().toISOString(),
      cached: false,
      totalUsdtContracts: usdtTotal,
      filteredOut: usdtTotal - list.length,
      list,
      summary: summarize(list),
    };
    cache = { at: now, data: snapshot };
    return snapshot;
  } catch (err) {
    // 网络不通 / 被限流 / 区域限制 —— 用本地快照保证 demo 永远能演示
    const mock = require('./mock.json');
    // 快照里存的是「距离下次结算还有几分钟」，读的时候换算成绝对时间戳，
    // 这样无论什么时候打开，倒计时都是有效的，不会出现负数
    const base = Date.now();
    const list = mock.list
      .map((item) => ({
        ...item,
        nextFundingTime: base + mock.nextFundingInMinutes * 60 * 1000,
      }))
      .sort((a, b) => b.annualized - a.annualized);

    return {
      source: 'mock',
      note: mock.note,
      fetchedAt: new Date().toISOString(),
      cached: false,
      fallbackReason: err.message,
      list,
      summary: summarize(list),
    };
  }
}

module.exports = { getFundingSnapshot, annualize, normalize, summarize };
