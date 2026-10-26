// 场景:只添加「协议引擎类」档案 → 必须出现在 VPN 接入主页面列表
// (回归点:空状态/计数/新增按钮原先只数 corporate,只加引擎时页面仍显示空状态)
const { spawn, execSync } = require('child_process');
const path = require('path');

const DATA_DIR = path.join(process.env.TEMP, 'bw-unified-' + Date.now());
const proc = spawn(path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--remote-debugging-port=9225'],
  { cwd: process.cwd(), env: { ...process.env, BLUEWING_DATA_DIR: DATA_DIR }, stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9225/json')).json();
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

  const results = [];
  const step = async (name, fn) => {
    try { const ok = await fn(); results.push([ok ? 'PASS' : 'FAIL', name]); if (!ok) throw new Error(name); }
    catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); throw e; }
  };
  const clickText = (txt) => ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.replace(/\\s+/g,'').includes('${txt}')&&b.offsetParent!==null); b?.click(); return !!b; })()`);
  const setInput = `(ph, v) => { const i=[...document.querySelectorAll('input')].find(e=>e.placeholder&&e.placeholder.includes(ph)&&e.offsetParent!==null); if(!i) return false; const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(i,v); i.dispatchEvent(new Event('input',{bubbles:true})); return true; }`;

  await step('初始为空状态', async () => {
    await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='VPN 接入')?.click()`);
    await sleep(700);
    return ev(`!![...document.querySelectorAll('h3')].find(h=>h.textContent.includes('添加你的第一个 VPN 接入'))`);
  });

  await step('类型弹层直列全部类型,点 IKEv2 直开编辑器', async () => {
    await clickText('添加接入');
    await sleep(400);
    const hasAll = await ev(`['EasyConnect','aTrust','IKEv2','L2TP/IPsec','SSTP','OpenVPN','WireGuard','AnyConnect'].every(t=>[...document.querySelectorAll('button')].some(b=>b.textContent.includes(t)&&b.offsetParent!==null))`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(path.join(process.env.TEMP, 'bw-add-picker.png'), Buffer.from(shot.data, 'base64'));
    await clickText('IKEv2');
    await sleep(700);
    const editorOpen = await ev(`!![...document.querySelectorAll('h2')].find(h=>h.textContent.includes('添加 VPN 账号'))`);
    const editorTitle = await ev(`[...document.querySelectorAll('h2')].find(h=>h.offsetParent!==null&&h.textContent.includes('VPN 账号'))?.textContent`);
    return hasAll && editorOpen && editorTitle === '添加 VPN 账号';
  });

  await step('填写并保存引擎档案', async () => {
    await ev(`(${setInput})('公司内网 VPN', '测试引擎节点')`);
    await ev(`(${setInput})('vpn.example.com', '10.99.0.1')`);
    await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('保存账号'))?.click()`);
    await sleep(900);
    return ev(`![...document.querySelectorAll('h2')].find(h=>h.textContent.includes('添加 VPN 账号'))`);
  });

  await step('主列表出现引擎档案(不再空状态)', async () => {
    const ws0 = await ev(`!!document.querySelector('[aria-label="VPN 接入配置"]')`);
    const emptyGone = await ev(`![...document.querySelectorAll('h3')].find(h=>h.textContent.includes('添加你的第一个 VPN 接入'))`);
    const itemName = await ev(`[...document.querySelectorAll('.vpn-profile-item, [aria-label="VPN 接入配置"] *')].some(e=>e.textContent.includes('测试引擎节点'))`);
    const count = await ev(`document.querySelector('.vpn-list-heading span')?.textContent`);
    return ws0 && emptyGone && itemName && count === '01';
  });

  await step('引擎项可选中并出现详情面板', async () => {
    await ev(`(() => { const it=[...document.querySelectorAll('.vpn-profile-item')].find(e=>e.textContent.includes('测试引擎节点')); it?.click(); return !!it; })()`);
    await sleep(600);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(path.join(process.env.TEMP, 'bw-unified-list.png'), Buffer.from(shot.data, 'base64'));
    return ev(`!!document.querySelector('[aria-label="VPN 接入配置"]') && ![...document.querySelectorAll('h3')].find(h=>h.textContent.includes('添加你的第一个 VPN 接入'))`);
  });

  console.log('=== RESULTS ===');
  for (const [st, name] of results) console.log(st, name);
  console.log('ALL PASS');
})()
  .catch((e) => { console.error('ERR', e.message); process.exitCode = 1; })
  .finally(() => { try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch {} setTimeout(() => process.exit(process.exitCode || 0), 600); });
