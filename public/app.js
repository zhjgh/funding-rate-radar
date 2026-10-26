/**
 * 前端渲染层：零依赖原生 ESM
 * 拉数据 → 排序 → 渲染 → 每秒更新倒计时 → 每 30 秒自动刷新
 */

const REFRESH_MS = 30 * 1000;

const state = {
  list: [],
  sortKey: 'annualized',
  sortDir: -1, // -1 降序，1 升序
};

const $ = (sel) => document.querySelector(sel);

/* ---------------- 格式化 ---------------- */

// 当期费率：小数 → 百分比，保留 4 位（0.0001 → 0.0100%）
const fmtRate = (rate) => (rate * 100).toFixed(4) + '%';

// 年化：带正负号，保留 2 位
const fmtAnnual = (v) => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';

// 价格：按量级自适应小数位，PEPE 这类低价币也能看清
function fmtPrice(v) {
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (v >= 1) return v.toFixed(3);
  if (v >= 0.01) return v.toFixed(4);
  return v.toFixed(8);
}

function fmtCountdown(ms) {
  if (ms <= 0) return '结算中';
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

/* ---------------- 渲染 ---------------- */

function renderStatus(data) {
  const PROVIDER = { bybit: 'Bybit', binance: 'Binance' };
  const isLive = Boolean(PROVIDER[data.source]);
  const isSnapshot = data.source === 'snapshot';
  // 快照也标出原始交易所，避免看的人以为是假数据
  const sourceName = PROVIDER[data.source] || PROVIDER[data.provider] || '交易所';

  $('#sourceDot').className = 'dot ' + (isLive ? 'live' : isSnapshot ? 'snapshot' : 'mock');
  $('#sourceText').textContent = isLive
    ? `实时数据 · ${sourceName}`
    : isSnapshot
    ? `快照数据 · ${sourceName}`
    : '离线演示数据';

  // 快照显示的是抓取时间而不是本次请求时间，否则看的人会误以为数据是新的
  const stamp = isSnapshot && data.snapshotAt ? new Date(data.snapshotAt) : new Date(data.fetchedAt);
  $('#updatedText').textContent = stamp.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  $('#note').textContent = isLive
    ? `来源 ${sourceName} 线性合约，按日成交额筛出最活跃的 ${data.list.length} 个合约；年化按各自结算周期换算。`
    : isSnapshot
    ? `部署环境无法直连交易所接口（${data.fallbackReason || '网络不可达'}），因此展示最近一次真实抓取的行情快照，数值真实但非实时。`
    : `当前为离线演示数据（${data.fallbackReason || '网络不可达'}），仅用于保证 demo 可演示，不是真实行情。`;
}

function renderStats(summary) {
  if (!summary) return;
  const cards = [
    { label: '合约数量', value: summary.count, tone: '' },
    { label: '最高年化', value: fmtAnnual(summary.max), tone: 'pos' },
    { label: '中位数', value: fmtAnnual(summary.median), tone: summary.median >= 0 ? 'pos' : 'neg' },
    { label: '最低年化', value: fmtAnnual(summary.min), tone: 'neg' },
    { label: '正费率占比', value: Math.round((summary.positiveCount / summary.count) * 100) + '%', tone: '' },
  ];
  $('#stats').innerHTML = cards
    .map(
      (c) => `<div class="card">
        <span class="card-label">${c.label}</span>
        <strong class="card-value ${c.tone}">${c.value}</strong>
      </div>`
    )
    .join('');
}

function render() {
  const list = [...state.list].sort((a, b) => {
    const av = a[state.sortKey];
    const bv = b[state.sortKey];
    if (typeof av === 'string') return av.localeCompare(bv) * state.sortDir;
    return (av - bv) * state.sortDir;
  });

  // 强度条以「P90 分位」为基准归一化，而不是最大绝对值：
  // 榜单里常有一个 -4000% 的极端合约，拿它当分母会把其余 60 多行压成一条细线，
  // 整列就失去意义了。用 P90 当满格基准，超出的直接饱和到满格显示。
  const absSorted = list.map((x) => Math.abs(x.annualized)).sort((a, b) => a - b);
  const ref = Math.max(absSorted[Math.floor(absSorted.length * 0.9)] || 1, 1);
  const TRACK_PX = 120; // 条形满格宽度，用像素而不是百分比，避免和 td 的自动宽度互相依赖

  $('#rows').innerHTML = list
    .map((item) => {
      const isPos = item.annualized >= 0;
      const tone = isPos ? 'pos' : 'neg';
      const width = Math.max(3, Math.min(TRACK_PX, (Math.abs(item.annualized) / ref) * TRACK_PX));
      return `<tr>
        <td class="symbol">${item.symbol.replace('USDT', '')}<span class="quote">USDT</span>${
          item.intervalHour && item.intervalHour !== 8
            ? `<span class="interval">${item.intervalHour}h</span>`
            : ''
        }</td>
        <td class="num ${tone}">${fmtRate(item.rate)}</td>
        <td class="num ${tone} strong">${fmtAnnual(item.annualized)}</td>
        <td class="num"><span class="bar ${tone}" style="width:${width.toFixed(0)}px"></span></td>
        <td class="num muted">${fmtPrice(item.markPrice)}</td>
        <td class="num countdown" data-ts="${item.nextFundingTime}">--:--:--</td>
      </tr>`;
    })
    .join('');

  // 表头排序箭头
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.classList.toggle('active', th.dataset.key === state.sortKey);
    th.dataset.dir = th.dataset.key === state.sortKey ? (state.sortDir === -1 ? 'desc' : 'asc') : '';
  });

  tick();
}

/* ---------------- 交互 ---------------- */

function bindSort() {
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (state.sortKey === key) {
        state.sortDir *= -1;
      } else {
        state.sortKey = key;
        state.sortDir = key === 'symbol' ? 1 : -1;
      }
      render();
    });
  });
}

function tick() {
  const now = Date.now();
  document.querySelectorAll('[data-ts]').forEach((el) => {
    el.textContent = fmtCountdown(Number(el.dataset.ts) - now);
  });
}

/* ---------------- 启动 ---------------- */

const FETCH_TIMEOUT = 10 * 1000;
let firstLoadDone = false;

async function load() {
  // 没有超时兜底的 fetch 会一直挂着，页面就永远停在「加载中」。
  // 之前接口要等 16 秒（两个数据源串行超时），就是这么卡住的。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);

  try {
    // 把页面上的查询参数原样透传给接口：本地跑是空串，
    // 部署平台会带 ?sharecode=xxx 做访问校验，不带就 403。
    const res = await fetch('/api/funding' + window.location.search, { signal: ctrl.signal });
    if (!res.ok) throw new Error('接口返回 HTTP ' + res.status);
    const data = await res.json();
    if (!data.list || !data.list.length) throw new Error('接口返回空数据集');

    state.list = data.list;
    renderStatus(data);
    renderStats(data.summary);
    render();
    firstLoadDone = true;
  } catch (err) {
    const msg = err.name === 'AbortError' ? `请求超时（${FETCH_TIMEOUT / 1000}s）` : err.message;
    // 已经拿到过数据的话，保留旧表格，只在状态栏标红，不要清空
    if (!firstLoadDone) {
      $('#rows').innerHTML = `<tr><td colspan="6" class="loading">加载失败：${msg}，正在重试…</td></tr>`;
    }
    $('#sourceDot').className = 'dot mock';
    $('#sourceText').textContent = '连接失败';
    $('#note').textContent = `${msg}。页面会在 10 秒后自动重试。`;
    setTimeout(load, 10000);
  } finally {
    clearTimeout(timer);
  }
}

bindSort();
load();
setInterval(tick, 1000);        // 倒计时每秒走
setInterval(load, REFRESH_MS);  // 数据每 30 秒刷
