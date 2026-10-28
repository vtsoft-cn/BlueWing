// 烟测:删除按钮→取消→再点删除 的二次交互回归
const { spawn } = require('child_process');
const path = require('path');
const DATA_DIR = path.join(process.env.TEMP, 'bw-deltwice-' + Date.now());
const proc = spawn(path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--remote-debugging-port=9240'],
  { cwd: process.cwd(), env: { ...process.env, BLUEWING_DATA_DIR: DATA_DIR }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9240/json')).json();
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
  const setInput = `(ph, v) => { const i=[...document.querySelectorAll('input')].find(e=>e.placeholder&&e.placeholder.includes(ph)&&e.offsetParent!==null); if(!i) return false; const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(i,v); i.dispatchEvent(new Event('input',{bubbles:true})); return true; }`;
  const shotTo = (name) => send('Page.captureScreenshot', { format: 'png' })
    .then((s) => require('fs').writeFileSync(path.join(process.env.TEMP, name), Buffer.from(s.data, 'base64')));

  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='VPN 接入')?.click()`);
  await sleep(800);
  // 添加 IKEv2
  await clickText('添加接入'); await sleep(400);
  await clickText('IKEv2'); await sleep(800);
  await ev(`(${setInput})('公司内网 VPN', '节点甲')`);
  await ev(`(${setInput})('vpn.example.com', '10.99.0.1')`);
  await clickText('保存账号'); await sleep(900);
  // 添加第二个 IKEv2
  await clickText('新增接入'); await sleep(400);
  await clickText('IKEv2'); await sleep(800);
  await ev(`(${setInput})('公司内网 VPN', '节点乙')`);
  await ev(`(${setInput})('vpn.example.com', '10.99.0.2')`);
  await clickText('保存账号'); await sleep(900);
  console.log('count:', await ev(`document.querySelector('.vpn-list-heading span')?.textContent`));

  // 选中节点甲
  await ev(`(() => { const it=[...document.querySelectorAll('.vpn-profile-item')].find(e=>e.textContent.includes('节点甲')); it?.click(); })()`);
  await sleep(600);

  // 第 1 次:点删除 → 取消
  await ev(`(() => { const it=[...document.querySelectorAll('.vpn-profile-item')].find(e=>e.textContent.includes('节点甲')); it.querySelector('.vpn-item-delete').click(); })()`);
  await sleep(500);
  console.log('dialog1 text len:', await ev(`(() => { const d=[...document.querySelectorAll('div')].find(d=>d.className&&String(d.className).includes('bg-white dark:bg-slate-900')&&d.textContent.includes('确定要删除')); return d?d.textContent.length:-1; })()`));
  await clickText('取消');
  await sleep(600);

  // 第 2 次:再点删除 → 取消
  await ev(`(() => { const it=[...document.querySelectorAll('.vpn-profile-item')].find(e=>e.textContent.includes('节点甲')); it.querySelector('.vpn-item-delete').click(); })()`);
  await sleep(500);
  await shotTo('bw-deltwice-dialog2.png');
  console.log('dialog2 text len:', await ev(`(() => { const d=[...document.querySelectorAll('div')].find(d=>d.className&&String(d.className).includes('bg-white dark:bg-slate-900')&&d.textContent.includes('确定要删除')); return d?d.textContent.length:-1; })()`));
  await clickText('取消');
  await sleep(600);

  // 第 3 次:再点删除 → 确认删除
  await ev(`(() => { const it=[...document.querySelectorAll('.vpn-profile-item')].find(e=>e.textContent.includes('节点甲')); it.querySelector('.vpn-item-delete').click(); })()`);
  await sleep(500);
  await clickText('确定');
  await sleep(1200);

  // 断言:详情面板仍显示「节点乙」信息
  await shotTo('bw-deltwice-final.png');
  console.log('detail title:', await ev(`document.querySelector('.vpn-connection-card h3')?.textContent`));
  console.log('cards:', await ev(`document.querySelectorAll('.vpn-profile-item').length`));
  console.log('detail body text len:', await ev(`document.querySelector('.vpn-connection-card')?.textContent.length`));
  proc.kill();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); try { proc.kill(); } catch {} process.exit(1); });
