// 烟测:VPN 卡片 hover 动画验证(鼠标移入卡片,截前后对比+度量边框/背景变化)
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const DATA_DIR = path.join(process.env.TEMP, 'bw-hover-' + Date.now());
const LOGF = path.join(process.cwd(), 'scripts', 'tmp-flash', 'hover.log');
const _log = (m) => { try { fs.appendFileSync(LOGF, String(m) + '\n'); } catch {} console.log(m); };
const proc = spawn(path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--remote-debugging-port=9244'],
  { cwd: process.cwd(), env: { ...process.env, BLUEWING_DATA_DIR: DATA_DIR }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9244/json')).json();
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
  await send('Page.enable');
  await sleep(1200);
  const clickText = (txt) => ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.replace(/\\s+/g,'').includes('${txt}')&&b.offsetParent!==null); b?.click(); return !!b; })()`);
  const setInput = `(ph, v) => { const i=[...document.querySelectorAll('input')].find(e=>e.placeholder&&e.placeholder.includes(ph)&&e.offsetParent!==null); if(!i) return false; const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(i,v); i.dispatchEvent(new Event('input',{bubbles:true})); return true; }`;
  const shotTo = (name) => send('Page.captureScreenshot', { format: 'png' })
    .then((s) => fs.writeFileSync(path.join(process.env.TEMP, name), Buffer.from(s.data, 'base64')));

  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='VPN 接入')?.click()`);
  await sleep(800);
  await clickText('添加接入'); await sleep(400);
  await clickText('IKEv2'); await sleep(800);
  await ev(`(${setInput})('公司内网 VPN', '悬停测试')`);
  await ev(`(${setInput})('vpn.example.com', '10.99.0.1')`);
  await clickText('保存账号'); await sleep(900);
  // 第二张(非选中)
  await clickText('新增接入'); await sleep(400);
  await clickText('IKEv2'); await sleep(800);
  await ev(`(${setInput})('公司内网 VPN', '悬停测试乙')`);
  await ev(`(${setInput})('vpn.example.com', '10.99.0.2')`);
  await clickText('保存账号'); await sleep(900);
  // 选中第一张,使第二张处于非选中态(hover 验证目标)
  await ev(`(() => { const it=[...document.querySelectorAll('.vpn-profile-item')].find(e=>e.textContent.includes('悬停测试')); it?.click(); })()`);
  await sleep(600);

  const rect = await ev(`(() => { const it=[...document.querySelectorAll('.vpn-profile-item')].find(e=>e.textContent.includes('悬停测试乙')); const r=it.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}); })()`);
  const r = JSON.parse(rect);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const before = await ev(`(() => { const it=[...document.querySelectorAll('.vpn-profile-item')].find(e=>e.textContent.includes('悬停测试乙')); const cs=getComputedStyle(it); return JSON.stringify({border:cs.borderColor, bg:cs.backgroundColor, transition:cs.transitionDuration}); })()`);
  await shotTo('bw-hover-before.png');
  // 鼠标移入卡片(CDP Input.dispatchMouseEvent mousemoved)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
  await sleep(400);
  const after = await ev(`(() => { const it=[...document.querySelectorAll('.vpn-profile-item')].find(e=>e.textContent.includes('悬停测试乙')); const cs=getComputedStyle(it); return JSON.stringify({border:cs.borderColor, bg:cs.backgroundColor, transition:cs.transitionDuration}); })()`);
  await shotTo('bw-hover-after.png');
  _log('before: ' + before);
  _log('after:  ' + after);
  proc.kill();
  process.exit(0);
})().catch((e) => { _log('ERR ' + e.message); try { proc.kill(); } catch {} process.exit(1); });
