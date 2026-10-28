// 烟测:VPN 接入左侧卡片列表删除按钮
// 流程:添加 IKEv2 引擎档案 → 卡片出现删除钮 → 点删除 → 确认弹窗 → 确认 → 卡片消失回空状态
// 另验证:点删除不触发卡片选中(click 冒泡被 stopPropagation 拦截)
const { spawn } = require('child_process');
const path = require('path');

const DATA_DIR = path.join(process.env.TEMP, 'bw-carddel-' + Date.now());
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
  await sleep(1200);

  const results = [];
  const step = async (name, fn) => {
    try { const ok = await fn(); results.push([ok ? 'PASS' : 'FAIL', name]); if (!ok) throw new Error(name); }
    catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); throw e; }
  };
  const clickText = (txt) => ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.replace(/\\s+/g,'').includes('${txt}')&&b.offsetParent!==null); b?.click(); return !!b; })()`);
  const setInput = `(ph, v) => { const i=[...document.querySelectorAll('input')].find(e=>e.placeholder&&e.placeholder.includes(ph)&&e.offsetParent!==null); if(!i) return false; const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(i,v); i.dispatchEvent(new Event('input',{bubbles:true})); return true; }`;

  await step('进入 VPN 接入页并添加 IKEv2 档案', async () => {
    await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='VPN 接入')?.click()`);
    await sleep(700);
    await clickText('添加接入');
    await sleep(400);
    await clickText('IKEv2');
    await sleep(700);
    await ev(`(${setInput})('公司内网 VPN', '删除烟测节点')`);
    await ev(`(${setInput})('vpn.example.com', '10.99.0.1')`);
    await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('保存账号'))?.click()`);
    await sleep(900);
    return ev(`[...document.querySelectorAll('.vpn-profile-item')].some(e=>e.textContent.includes('删除烟测节点'))`);
  });

  await step('卡片内出现删除按钮(aria-label)', async () => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(path.join(process.env.TEMP, 'bw-card-delete.png'), Buffer.from(shot.data, 'base64'));
    return ev(`(() => { const it=[...document.querySelectorAll('.vpn-profile-item')].find(e=>e.textContent.includes('删除烟测节点')); return !!it && !!it.querySelector('.vpn-item-delete') && it.querySelector('.vpn-item-delete').getAttribute('aria-label').includes('删除'); })()`);
  });

  await step('点删除弹出确认框(且不触发卡片选中切换)', async () => {
    const selectedBefore = await ev(`!!document.querySelector('.vpn-profile-item.selected')`);
    await ev(`(() => { const it=[...document.querySelectorAll('.vpn-profile-item')].find(e=>e.textContent.includes('删除烟测节点')); it.querySelector('.vpn-item-delete').click(); })()`);
    await sleep(500);
    const dialogText = await ev(`[...document.querySelectorAll('*')].some(e=>e.children.length===0&&e.textContent.includes('确定要删除「删除烟测节点」'))`);
    const selectedAfter = await ev(`!!document.querySelector('.vpn-profile-item.selected')`);
    return dialogText && selectedBefore === selectedAfter;
  });

  await step('取消则卡片保留', async () => {
    await clickText('取消');
    await sleep(500);
    const dialogGone = await ev(`![...document.querySelectorAll('*')].some(e=>e.children.length===0&&e.textContent.includes('确定要删除「删除烟测节点」'))`);
    const stillThere = await ev(`[...document.querySelectorAll('.vpn-profile-item')].some(e=>e.textContent.includes('删除烟测节点'))`);
    return dialogGone && stillThere;
  });

  await step('再次删除并确认,卡片消失回到空状态', async () => {
    await ev(`(() => { const it=[...document.querySelectorAll('.vpn-profile-item')].find(e=>e.textContent.includes('删除烟测节点')); it.querySelector('.vpn-item-delete').click(); })()`);
    await sleep(500);
    const clicked = await clickText('确定');
    console.log('  confirm clicked:', clicked);
    await sleep(1200);
    const gone = await ev(`![...document.querySelectorAll('.vpn-profile-item')].some(e=>e.textContent.includes('删除烟测节点'))`);
    const emptyState = await ev(`[...document.querySelectorAll('h3')].some(h=>h.textContent.includes('添加你的第一个 VPN 接入'))`);
    const count = await ev(`document.querySelector('.vpn-list-heading span')?.textContent`);
    console.log('  gone:', gone, 'emptyState:', emptyState, 'count:', JSON.stringify(count));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(path.join(process.env.TEMP, 'bw-card-deleted.png'), Buffer.from(shot.data, 'base64'));
    // 空状态下列表头部(含计数)整个不渲染,count 为 undefined 属正常
    return gone && emptyState && (count === '00' || count === undefined);
  });

  console.log('=== RESULTS ===');
  for (const [st, name] of results) console.log(st, name);
  console.log('ALL PASS');
  proc.kill();
  process.exit(0);
})()
  .catch((e) => { console.error('ERR', e.message); try { proc.kill(); } catch {} process.exit(1); });
