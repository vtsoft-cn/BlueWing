// 度量对比:VPN 编辑器控件 vs 其它页面(路由/设置)控件的实际渲染高度
const { spawn, execSync } = require('child_process');
const path = require('path');

const DATA_DIR = path.join(process.env.TEMP, 'bw-measure-' + Date.now());
const proc = spawn(path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--remote-debugging-port=9223'],
  { cwd: process.cwd(), env: { ...process.env, BLUEWING_DATA_DIR: DATA_DIR }, stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9223/json')).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error('no target');
}
let ws, id = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;

(async () => {
  const t = await findTarget();
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
  await send('Runtime.enable');
  await sleep(1500);

  const measure = `(() => {
    const hs = (sel) => [...document.querySelectorAll(sel)]
      .filter((e) => e.offsetParent !== null)
      .map((e) => Math.round(e.getBoundingClientRect().height));
    const uniq = (a) => [...new Set(a)].sort((x, y) => x - y);
    return { buttons: uniq(hs('button')), inputs: uniq(hs('input:not([type=checkbox]), textarea')) };
  })()`;

  // VPN 编辑器(连接设置页)
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='VPN 接入')?.click()`);
  await sleep(700);
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim().includes('添加接入'))?.click()`);
  await sleep(400);
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('EasyConnect / aTrust'))?.click()`);
  await sleep(900);
  const vpnEditor = await ev(measure);

  // 路由页(应用标准页)
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='路由')?.click()`);
  await sleep(800);
  const routing = await ev(measure);

  // 设置页
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='设置')?.click()`);
  await sleep(800);
  const settings = await ev(measure);

  console.log('VPN编辑器  :', JSON.stringify(vpnEditor));
  console.log('路由页     :', JSON.stringify(routing));
  console.log('设置页     :', JSON.stringify(settings));
})()
  .catch((e) => { console.error('ERR', e.message); process.exitCode = 1; })
  .finally(() => { try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch {} setTimeout(() => process.exit(process.exitCode || 0), 600); });
