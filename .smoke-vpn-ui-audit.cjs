// 烟测:VPN 接入页各功能区全量截图(UI 排查素材)
const { spawn } = require('child_process');
const path = require('path');
const DATA_DIR = path.join(process.env.TEMP, 'bw-uiaudit-' + Date.now());
const proc = spawn(path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--remote-debugging-port=9230'],
  { cwd: process.cwd(), env: { ...process.env, BLUEWING_DATA_DIR: DATA_DIR }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9230/json')).json();
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
  const scrollDetail = (sel, pos) => ev(`(() => { const el=document.querySelector('${sel}'); if(el) el.scrollTop=${pos}; return !!el; })()`);
  const scrollWin = (pos) => ev(`(() => { const els=[...document.querySelectorAll('.vpn-detail-column,.vpn-workspace,main,.overflow-y-auto')]; els.forEach(e=>e.scrollTop=${pos}); window.scrollTo(0,0); return els.length; })()`);

  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='VPN 接入')?.click()`);
  await sleep(800);
  // 添加 IKEv2
  console.log('add1:', await clickText('添加接入')); await sleep(400);
  console.log('ikev2:', await clickText('IKEv2')); await sleep(800);
  console.log('name:', await ev(`(${setInput})('公司内网 VPN', '上海办公网')`));
  console.log('srv:', await ev(`(${setInput})('vpn.example.com', '10.99.0.1')`));
  console.log('save:', await clickText('保存账号')); await sleep(900);
  // 添加 EasyConnect
  console.log('add2:', await clickText('新增接入')); await sleep(500);
  console.log('ec:', await clickText('EasyConnect')); await sleep(900);
  console.log('editor open:', await ev(`!!document.querySelector('.vpn-editor')`));
  console.log('name2:', await ev(`(${setInput})('例如：办公网络、研发环境', '总部 EasyConnect')`));
  console.log('gw2:', await ev(`(${setInput})('vpn.example.com', 'gw.corp.com')`));
  console.log('save2:', await clickText('保存配置')); await sleep(1000);
  console.log('editor after save:', await ev(`!!document.querySelector('.vpn-editor')`));
  console.log('count:', await ev(`document.querySelector('.vpn-list-heading span')?.textContent`));
  console.log('invalid:', JSON.stringify(await ev(`[...document.querySelectorAll('.vpn-editor input')].filter(i=>!i.checkValidity()).map(i=>i.placeholder)`)));

  // 1. corporate 选中:详情上部
  await ev(`(() => { const it=[...document.querySelectorAll('.vpn-profile-item')].find(e=>e.textContent.includes('总部 EasyConnect')); it?.click(); })()`);
  await sleep(700);
  await shotTo('bw-a1-corp-detail-top.png');
  // 2. 详情列滚动到底
  await ev(`(() => { const c=document.querySelector('.vpn-detail-column'); const sc=c?c.querySelectorAll('*'):[]; let deepest=null; for(const e of sc){ if(e.scrollHeight>e.clientHeight+40 && getComputedStyle(e).overflowY!=='visible'){ if(!deepest||e.scrollHeight>deepest.scrollHeight) deepest=e; } } if(deepest) deepest.scrollTop=deepest.scrollHeight; return deepest?deepest.className.slice(0,40):'none'; })()`);
  await sleep(400);
  await shotTo('bw-a2-corp-detail-bottom.png');
  // 3. 页面整体滚动(流量去向卡)
  await scrollWin(99999);
  await sleep(400);
  await shotTo('bw-a3-traffic-card.png');

  // 4. engine 选中:详情
  await ev(`(() => { const it=[...document.querySelectorAll('.vpn-profile-item')].find(e=>e.textContent.includes('上海办公网')); it?.click(); })()`);
  await sleep(700);
  await shotTo('bw-a4-engine-detail.png');

  // 5. 搜索空状态
  await ev(`(() => { const i=document.querySelector('input[aria-label="搜索接入配置"]'); if(!i) return false; const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(i,'zzz'); i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await sleep(500);
  await shotTo('bw-a5-search-empty.png');

  // 6. 诊断设置展开(若可见)
  await ev(`(() => { const i=document.querySelector('input[aria-label="搜索接入配置"]'); const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(i,''); i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(400);
  await ev(`(() => { const it=[...document.querySelectorAll('.vpn-profile-item')].find(e=>e.textContent.includes('总部 EasyConnect')); it?.click(); })()`);
  await sleep(500);
  await clickText('诊断设置');
  await sleep(600);
  await shotTo('bw-a6-diag-settings.png');

  proc.kill();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); try { proc.kill(); } catch {} process.exit(1); });
