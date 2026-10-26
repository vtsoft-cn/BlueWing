// 复现:节点添加弹窗 X 关闭钮无效?分别用 el.click() 与坐标真实点击(Input.dispatchMouseEvent)
// 两种方式打 X,区分「处理器问题」vs「命中遮挡问题」;并抓页面 console 错误。
const { spawn, execSync } = require('child_process');
const path = require('path');

const DATA_DIR = path.join(process.env.TEMP, 'bw-xbug-' + Date.now());
const proc = spawn(path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--remote-debugging-port=9224'],
  { cwd: process.cwd(), env: { ...process.env, BLUEWING_DATA_DIR: DATA_DIR }, stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9224/json')).json();
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
  await sleep(1200);

  // 进节点页,开添加弹窗
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='节点')?.click()`);
  await sleep(700);
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('添加节点')||b.textContent.includes('手动添加'))?.click()`);
  await sleep(600);
  console.log('弹窗打开:', await ev(`!!document.querySelector('h3')?.textContent.includes('手动添加代理节点')`));

  // 方式一:DOM click 打 X(面板内可见的那个),先探针
  console.log('探针:', await ev(`(() => {
    const h = [...document.querySelectorAll('h3')].find(h => h.textContent.includes('手动添加代理节点'));
    const panel = h?.closest('div.rounded-2xl');
    const b = panel && [...panel.querySelectorAll('button')].find(x => x.querySelector('svg.lucide-x'));
    if (!b) return 'X button not found';
    window.__fired = 0;
    b.addEventListener('click', () => { window.__fired++; });
    window.__xb = b;
    const r = b.getBoundingClientRect();
    return { disabled: b.disabled, type: b.type, pointerEvents: getComputedStyle(b).pointerEvents,
             rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
             reactProps: Object.keys(b).filter(k => k.startsWith('__react')).length };
  })()`));
  await ev(`window.__xb.click()`);
  console.log('原生监听触发次数:', await ev(`window.__fired`));
  await sleep(500);
  const afterDomClick = await ev(`!![...document.querySelectorAll('h3')].find(h=>h.textContent.includes('手动添加代理节点'))`);
  console.log('DOM click 打 X 后弹窗仍在:', afterDomClick);

  // 若已关,重开
  if (!afterDomClick) {
    await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('添加节点')||b.textContent.includes('手动添加'))?.click()`);
    await sleep(600);
  }

  // 方式二:坐标真实点击 X(rect 中心)
  const rect = await ev(`(() => {
    const h = [...document.querySelectorAll('h3')].find(h => h.textContent.includes('手动添加代理节点'));
    const panel = h?.closest('div.rounded-2xl');
    const b = panel && [...panel.querySelectorAll('button')].find(x => x.querySelector('svg.lucide-x'));
    if (!b) return null;
    const r2 = b.getBoundingClientRect();
    const cx = r2.x + r2.width / 2, cy = r2.y + r2.height / 2;
    const at = document.elementFromPoint(cx, cy);
    return { x: cx, y: cy, elementAt: at ? at.tagName + '|' + String(at.className).slice(0, 60) : 'null' };
  })()`);
  console.log('X 坐标与 elementFromPoint:', JSON.stringify(rect));
  if (rect) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 });
    await sleep(500);
    const afterRealClick = await ev(`!![...document.querySelectorAll('h3')].find(h=>h.textContent.includes('手动添加代理节点'))`);
    console.log('坐标点击 X 后弹窗仍在:', afterRealClick);
    if (afterRealClick) {
      // 蒙版点击对照
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 30, y: 400, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 30, y: 400, button: 'left', clickCount: 1 });
      await sleep(500);
      const afterMask = await ev(`!![...document.querySelectorAll('h3')].find(h=>h.textContent.includes('手动添加代理节点'))`);
      console.log('坐标点击蒙版后弹窗仍在:', afterMask);
    }
  }

  // 引擎账号编辑弹窗(VpnProfileEditorModal)同样验证 X
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='VPN 接入')?.click()`);
  await sleep(600);
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('添加接入')||b.textContent.includes('新增接入'))?.click()`);
  await sleep(400);
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.replace(/\s+/g,'').includes('IKEv2')&&b.offsetParent!==null)?.click()`);
  await sleep(900);
  console.log('引擎弹窗打开:', await ev(`!![...document.querySelectorAll('h3')].find(h=>h.textContent.includes('添加 VPN 账号'))`));
  await ev(`(() => {
    const h = [...document.querySelectorAll('h3')].find(h => h.textContent.includes('添加 VPN 账号'));
    const panel = h?.closest('div.rounded-2xl');
    panel && [...panel.querySelectorAll('button')].find(x => x.querySelector('svg.lucide-x'))?.click();
  })()`);
  await sleep(500);
  console.log('引擎弹窗 X 点击后仍在:', await ev(`!![...document.querySelectorAll('h3')].find(h=>h.textContent.includes('添加 VPN 账号'))`));
})()
  .catch((e) => { console.error('ERR', e.message); process.exitCode = 1; })
  .finally(() => { try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch {} setTimeout(() => process.exit(process.exitCode || 0), 600); });
