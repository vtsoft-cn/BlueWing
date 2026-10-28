// 烟测:UI 修复验证(类型弹层无 hint / OpenVPN 无模式切换 / 两编辑器 footer 一致)
const { spawn } = require('child_process');
const path = require('path');
const DATA_DIR = path.join(process.env.TEMP, 'bw-uifix-' + Date.now());
const proc = spawn(path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--remote-debugging-port=9241'],
  { cwd: process.cwd(), env: { ...process.env, BLUEWING_DATA_DIR: DATA_DIR }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9241/json')).json();
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
    .then((s) => require('fs').writeFileSync(path.join(process.env.TEMP, name), Buffer.from(s.data, 'base64')));

  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='VPN 接入')?.click()`);
  await sleep(800);
  // 1. AddTypePicker:hint 应为空
  await clickText('添加接入');
  await sleep(500);
  await shotTo('bw-uifix-picker.png');
  console.log('picker hints visible:', await ev(`[...document.querySelectorAll('.vpn-provider-option small')].filter(s=>s.textContent.trim()).length`));
  await clickText('EasyConnect');
  await sleep(900);
  // 2. corporate footer 按钮
  const corpBtns = await ev(`(() => { const f=document.querySelector('.vpn-editor-footer'); if(!f) return null;
    return [...f.querySelectorAll('button')].map(b=>({t:b.textContent.trim(), h:Math.round(b.getBoundingClientRect().height), fs:getComputedStyle(b).fontSize, cls:b.className.slice(0,30)})); })()`);
  console.log('corp footer:', JSON.stringify(corpBtns));
  await shotTo('bw-uifix-corp.png');
  await clickText('取消'); await sleep(600);
  // 3. OpenVPN 编辑器:应无模式切换
  await clickText('添加接入'); await sleep(400);
  await clickText('OpenVPN'); await sleep(900);
  const modeSwitch = await ev(`[...document.querySelectorAll('button')].some(b=>b.offsetParent!==null&&(b.textContent.includes('手动填写')||b.textContent.includes('粘贴 .ovpn')))`);
  console.log('ovpn mode switch visible:', modeSwitch);
  await shotTo('bw-uifix-openvpn.png');
  await clickText('取消'); await sleep(600);
  // 4. engine footer 按钮
  await clickText('添加接入'); await sleep(400);
  await clickText('IKEv2'); await sleep(900);
  const engBtns = await ev(`(() => { const f=document.querySelector('.vpn-editor-footer'); if(!f) return null;
    return [...f.querySelectorAll('button')].map(b=>({t:b.textContent.trim(), h:Math.round(b.getBoundingClientRect().height), fs:getComputedStyle(b).fontSize, cls:b.className.slice(0,30)})); })()`);
  console.log('engine footer:', JSON.stringify(engBtns));
  await shotTo('bw-uifix-engine.png');
  proc.kill();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); try { proc.kill(); } catch {} process.exit(1); });
