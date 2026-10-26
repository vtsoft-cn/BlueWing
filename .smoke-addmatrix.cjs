// 复现:点击「添加接入」后类型弹层被隐藏?
const { spawn, execSync } = require('child_process');
const path = require('path');

const DATA_DIR = path.join(process.env.TEMP, 'bw-addmatrix-' + Date.now());
const outF = require('fs').openSync(path.join(process.env.TEMP, 'bw-matrix-el.log'), 'w');
const proc = spawn(path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--remote-debugging-port=9231'],
  { cwd: process.cwd(), env: { ...process.env, BLUEWING_DATA_DIR: DATA_DIR }, stdio: ['ignore', outF, outF] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9231/json')).json();
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
  await ev(`window.__errs=[]; window.addEventListener('error',e=>window.__errs.push(String(e.message))); 'hooked'`);
  await sleep(800);

  const pickerProbe = `(() => { try {
    const bd = [...document.querySelectorAll('.vpn-modal-backdrop')].find(b => b.textContent.includes('选择接入类型'));
    if (!bd) return 'picker-absent';
    const r = bd.getBoundingClientRect();
    const st = getComputedStyle(bd);
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + 30);
    return JSON.stringify({ vis: bd.offsetParent !== null || st.display !== 'none', z: st.zIndex, display: st.display, opacity: st.opacity, size: r.width + 'x' + r.height, topElement: at ? at.tagName + '|' + String(at.className).slice(0, 40) : 'null' });
  } catch (e) { return 'throw: ' + e.message; } })()`;
  const whatOpen = () => ev(`(() => {
    const t = (kw) => !!document.querySelector('.vpn-modal-backdrop')?.textContent.includes(kw);
    return t('选择接入类型') ? 'PICKER' : t('添加 VPN 账号') ? 'ENGINE-EDITOR' : t('新增 VPN 接入') ? 'CORP-EDITOR' : 'NONE';
  })()`);
  const clickAdd = () => ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>(b.textContent.includes('添加接入')||b.textContent.includes('新增接入'))&&b.offsetParent!==null); b?.click(); return !!b; })()`);

  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='VPN 接入')?.click()`);
  await sleep(800);

  // 行为矩阵:单击/双击 × 空状态
  console.log('空状态-单击添加接入 →', await (async () => { await clickAdd(); await sleep(600); return whatOpen(); })());
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='关闭'&&b.offsetParent!==null); b?.click(); })()`);
  await sleep(500);
  console.log('空状态-双击添加接入 →', await (async () => {
    await clickAdd(); await sleep(80); await clickAdd(); await sleep(600); return whatOpen();
  })());
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='关闭'&&b.offsetParent!==null); b?.click(); })()`);
  await sleep(500);
  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync(path.join(process.env.TEMP, 'bw-addmatrix-empty.png'), Buffer.from(shot1.data, 'base64'));
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync(path.join(process.env.TEMP, 'bw-picker-hide2.png'), Buffer.from(shot2.data, 'base64'));

  // === 带数据状态:保存一个 corporate 档案后再点添加接入 ===
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.replace(/\s+/g,'').includes('IKEv2')&&b.offsetParent!==null); b?.click(); return !!b; })()`);
  await sleep(500);
  // 此时打开的是引擎编辑器(IKEv2),填名称+服务器保存
  const setVal = `(ph, v) => { const i=[...document.querySelectorAll('input')].find(e=>e.placeholder&&e.placeholder.includes(ph)&&e.offsetParent!==null); if(!i) return false; const st=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; st.call(i,v); i.dispatchEvent(new Event('input',{bubbles:true})); return true; }`;
  await ev(`(${setVal})('公司内网 VPN', '测试引擎节点')`);
  await ev(`(${setVal})('vpn.example.com', '10.99.0.1')`);
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('保存账号'))?.click()`);
  await sleep(900);
  // 工作区头部 添加接入
  for (let round = 4; round <= 6; round++) {
    await clickAdd();
    await sleep(300);
    console.log(`工作区第${round}次点添加接入 弹层状态:`, await ev(pickerProbe));
    console.log('  点击行探针:', await ev(`(() => { try {
      const b=[...document.querySelectorAll('button')].find(b=>b.textContent.replace(/\s+/g,'').includes('EasyConnect')&&b.offsetParent!==null);
      if (!b) return 'no EasyConnect button';
      window.__rowc = 0; b.addEventListener('click', () => window.__rowc++);
      window.__row = b;
      b.click();
      return 'clicked: ' + b.textContent.slice(0, 30);
    } catch (e) { return 'throw: ' + e.message; } })()`));
    await sleep(700);
    console.log('  原生触发:', await ev(`window.__rowc`));
    console.log('  弹层/编辑器状态:', await ev(`JSON.stringify({ picker: !!document.querySelector('.vpn-modal-backdrop'), backdrops: document.querySelectorAll('.vpn-modal-backdrop').length, h2: [...document.querySelectorAll('h2')].map(h=>h.textContent).slice(0,3), errs: window.__errs.join('|') })`));
    console.log('  弹层内按钮:', await ev(`(() => { const bd=[...document.querySelectorAll('.vpn-modal-backdrop')].find(b=>b.textContent.includes('选择接入类型')); if(!bd) return 'no picker'; const bs=[...bd.querySelectorAll('button')]; return JSON.stringify(bs.map(b=>({ t: b.textContent.slice(0,14), off: b.offsetParent !== null, vis: b.getClientRects().length > 0 }))); })()`));
    console.log('  原样表达式计数:', await ev(`(() => { try {
      const all=[...document.querySelectorAll('button')];
      const texts=all.map(b=>b.textContent.slice(0,12));
      const squish='EasyConnect 账号'.replace(/\s+/g,'');
      const f1=all.filter(b=>b.textContent.includes('EasyConnect'));
      return JSON.stringify({ total: all.length, f1: f1.length, squish, texts: texts.slice(0,20) });
    } catch (e) { return 'throw: ' + e.message; } })()`));
    // 焦点样式探测:聚焦第一个输入框,读 focus 样式
    const focusInfo = await ev(`(() => { const i=[...document.querySelectorAll('input')].find(e=>e.offsetParent!==null); if(!i) return 'no input'; i.focus(); const st=getComputedStyle(i); return JSON.stringify({ boxShadow: st.boxShadow.slice(0,60), borderColor: st.borderColor }); })()`);
    console.log('  输入框 focus 样式:', focusInfo);
    await ev(`(() => { const h=[...document.querySelectorAll('h2')].find(h=>h.textContent.includes('VPN 接入')); const p=h?.closest('.vpn-surface'); p && [...p.querySelectorAll('button')].find(x=>x.querySelector('svg.lucide-x'))?.click(); })()`);
    await sleep(500);
    console.log('  JS错误:', await ev(`window.__errs.join('|') || '(无)'`));
  }
})()
  .catch((e) => { console.error('ERR', e.message); process.exitCode = 1; })
  .finally(() => { try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch {} setTimeout(() => process.exit(process.exitCode || 0), 600); });
