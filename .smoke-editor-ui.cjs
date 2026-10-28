// 烟测:新增 VPN 接入的两个编辑器截图(corporate EasyConnect / engine IKEv2),供 UI 排查
const { spawn } = require('child_process');
const path = require('path');
const DATA_DIR = path.join(process.env.TEMP, 'bw-edui-' + Date.now());
const proc = spawn(path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--remote-debugging-port=9229'],
  { cwd: process.cwd(), env: { ...process.env, BLUEWING_DATA_DIR: DATA_DIR }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9229/json')).json();
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
  await clickText('添加接入');
  await sleep(500);

  // corporate:EasyConnect
  await clickText('EasyConnect');
  await sleep(900);
  await shotTo('bw-ed-corp.png');
  // 高级分流 tab
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('高级分流')&&b.offsetParent!==null); b?.click(); })()`);
  await sleep(500);
  await shotTo('bw-ed-corp-routing.png');
  // 高级选项 tab
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('高级选项')&&b.offsetParent!==null); b?.click(); })()`);
  await sleep(500);
  await shotTo('bw-ed-corp-adv.png');
  // 关闭(无修改直接关)
  await clickText('取消');
  await sleep(600);

  // engine:IKEv2
  await clickText('添加接入');
  await sleep(500);
  await clickText('IKEv2');
  await sleep(900);
  await shotTo('bw-ed-engine.png');
  await clickText('取消');
  await sleep(400);

  // 度量:编辑器内控件尺寸/字号汇总
  await clickText('添加接入'); await sleep(400);
  await clickText('EasyConnect'); await sleep(900);
  const metrics = await ev(`(() => {
    const ed = document.querySelector('.vpn-editor');
    if (!ed) return 'no-editor';
    const out = [];
    for (const el of ed.querySelectorAll('input, select, textarea, button')) {
      if (el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      out.push({ tag: el.tagName, type: el.type || '', cls: (el.className||'').toString().slice(0, 40),
        h: Math.round(r.height), fs: cs.fontSize, radius: cs.borderRadius, lh: cs.lineHeight,
        ph: el.placeholder || '', text: (el.textContent||'').trim().slice(0, 14) });
    }
    return out;
  })()`);
  console.log(JSON.stringify(metrics, null, 1));
  proc.kill();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); try { proc.kill(); } catch {} process.exit(1); });
