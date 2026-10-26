// 全页面样式一致性审计:逐页截图,供人工/模型核对风格统一
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(process.env.TEMP, 'bw-audit-' + Date.now());
const proc = spawn(path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--remote-debugging-port=9226'],
  { cwd: process.cwd(), env: { ...process.env, BLUEWING_DATA_DIR: DATA_DIR }, stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9226/json')).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error('no target');
}
let ws, id = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

(async () => {
  const t = await findTarget();
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
  await send('Runtime.enable');
  await sleep(1500);

  const pages = ['首页', '节点', '订阅', '路由', '应用分流', 'DNS', '测速', '日志', '备份', '设置', 'VPN 接入'];
  const outDir = path.join(process.env.TEMP, 'bw-page-audit');
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of pages) {
    const ok = await ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='${name}'&&b.offsetParent!==null); b?.click(); return !!b; })()`);
    await sleep(900);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(outDir, `${pages.indexOf(name)}-${name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log((ok ? 'OK  ' : 'MISS'), name, '->', file);
  }
})()
  .catch((e) => { console.error('ERR', e.message); process.exitCode = 1; })
  .finally(() => { try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch {} setTimeout(() => process.exit(process.exitCode || 0), 600); });
