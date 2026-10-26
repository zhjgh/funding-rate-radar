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
  const isLive = data.source === 'binance';
  $('#sourceDot').className = 'dot ' + (isLive ? 'live' : 'mock');
  $('#sourceText').textContent = isLive ? '实时数据' : '离线演示数据';
  $('#updatedText').textContent = new Date(data.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false });
  $('#note').textContent = isLive
    ? `已从 ${data.totalUsdtContracts} 个 USDT 永续合约中，按日成交额筛出最活跃的 ${data.list.length} 个（剔除低流动性合约与法币汇率对 ${data.filteredOut} 个）。`
    : `当前为离线快照（原因：${data.fallbackReason || '网络不可达'}），数据非实时。`;
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

  // 强度条以当前最大绝对年化为基准，让极端值一眼看出来
  const maxAbs = Math.max(...list.map((x) => Math.abs(x.annualized)), 1);

  $('#rows').innerHTML = list
    .map((item) => {
      const isPos = item.annualized >= 0;
      const tone = isPos ? 'pos' : 'neg';
      const width = Math.max(2, (Math.abs(item.annualized) / maxAbs) * 100);
      return `<tr>
        <td class="symbol">${item.symbol.replace('USDT', '')}<span class="quote">USDT</span></td>
        <td class="num ${tone}">${fmtRate(item.rate)}</td>
        <td class="num ${tone} strong">${fmtAnnual(item.annualized)}</td>
        <td class="num"><span class="bar ${tone}" style="width:${width}%"></span></td>
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

async function load() {
  try {
    const res = await fetch('/api/funding');
    if (!res.ok) throw new Error('接口返回 ' + res.status);
    const data = await res.json();
    state.list = data.list || [];
    renderStatus(data);
    renderStats(data.summary);
    render();
  } catch (err) {
    $('#rows').innerHTML = `<tr><td colspan="6" class="loading">加载失败：${err.message}</td></tr>`;
  }
}

bindSort();
load();
setInterval(tick, 1000);        // 倒计时每秒走
setInterval(load, REFRESH_MS);  // 数据每 30 秒刷
