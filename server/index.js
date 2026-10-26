/**
 * 零依赖 HTTP 服务
 * ------------------------------------------------------------
 * 两个职责：
 *   1. GET /api/funding  → 返回全市场永续合约资金费率快照
 *   2. 其余路径          → 当作静态文件，从 public/ 目录读取
 *
 * 为什么不用 Express / Koa：
 *   demo 只有两个路由，Node 内置 http + fs 足够，
 *   零依赖 = 面试官 clone 下来不用 npm install 就能跑。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { getFundingSnapshot } = require('./binance');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 静态文件：把 URL 映射到 public 目录，并挡掉 ../ 路径穿越 */
function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, relative);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/funding')) {
    try {
      const snapshot = await getFundingSnapshot();
      sendJSON(res, 200, snapshot);
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`资金费率雷达已启动  →  http://localhost:${PORT}`);
  console.log(`数据接口            →  http://localhost:${PORT}/api/funding`);
});
