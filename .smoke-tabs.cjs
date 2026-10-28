// 烟测:tab 结构+焦点样式验证(输出落盘 scripts/tmp-flash/tabs-run.log)
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const DATA_DIR = path.join(process.env.TEMP, 'bw-tabs2-' + Date.now());
const LOGF = path.join(process.cwd(), 'scripts', 'tmp-flash', 'tabs-run.log');
const _log = (m) => { try { fs.appendFileSync(LOGF, String(m) + '\n'); } catch {} console.log(m); };
const proc = spawn(path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--remote-debugging-port=9242'],
  { cwd: process.cwd(), env: { ...process.env, BLUEWING_DATA_DIR: DATA_DIR }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9242/json')).json();
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
  const clickText = (txt) => ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.replace(/\\s+/g,'').includes('${txt}')&&b.offsetParent!==null); b?.click(); return !!b; })()`);
  const shotTo = (name) => send('Page.captureScreenshot', { format: 'png' })
    .then((s) => fs.writeFileSync(path.join(process.env.TEMP, name), Buffer.from(s.data, 'base64')));

  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='VPN 接入')?.click()`);
  await sleep(800);
  await clickText('添加接入'); await sleep(400);
  await clickText('IKEv2'); await sleep(900);
  _log('tabs count: ' + await ev(`document.querySelectorAll('.vpn-editor-tabs [role="tab"]').length`));
  _log('asterisk count: ' + await ev(`[...document.querySelectorAll('.vpn-editor-body span.text-blue-500')].filter(s=>s.textContent.trim()==='*').length`));
  await shotTo('bw-tabs-engine-conn.png');
  await ev(`(() => { const t=[...document.querySelectorAll('.vpn-editor-tabs [role="tab"]')].find(b=>b.textContent.includes('高级选项')); t?.click(); })()`);
  await sleep(400);
  await shotTo('bw-tabs-engine-adv.png');
  _log('advanced visible: ' + await ev(`(() => { const s=[...document.querySelectorAll('[role="tabpanel"]')].find(x=>x.getAttribute('aria-label')==='高级选项'); return s&&s.offsetParent!==null; })()`));
  _log('targets fields: ' + await ev(`(() => { const adv=[...document.querySelectorAll('[role="tabpanel"]')].find(x=>x.getAttribute('aria-label')==='高级选项'); if(!adv) return 'no-panel'; const t=adv.querySelectorAll('textarea'); return JSON.stringify({textareas:t.length, labels:[...adv.querySelectorAll('.vpn-field > span')].map(s=>s.textContent.trim()).slice(0,5)}); })()`));
  await clickText('取消'); await sleep(600);
  await clickText('添加接入'); await sleep(400);
  await clickText('EasyConnect'); await sleep(900);
  const focus = await ev(`(() => { const i=document.querySelector('.vpn-editor .vpn-input'); if(!i) return 'no-input'; i.focus(); const cs=getComputedStyle(i); return JSON.stringify({active:document.activeElement===i, disabled:i.disabled, border:cs.borderColor, shadow:cs.boxShadow.slice(0,60)}); })()`);
  _log('corp focused input: ' + focus);
  await shotTo('bw-tabs-corp-focus.png');
  proc.kill();
  process.exit(0);
})().catch((e) => { _log('ERR ' + e.message); try { proc.kill(); } catch {} process.exit(1); });
