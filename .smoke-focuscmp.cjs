// 度量对比 v3:节点弹窗(基准)与 VPN 两编辑器的 footer 按钮 + 全部输入控件焦点
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const DATA_DIR = path.join(process.env.TEMP, 'bw-focuscmp3-' + Date.now());
const LOGF = path.join(process.cwd(), 'scripts', 'tmp-flash', 'focuscmp3.log');
const _log = (m) => { try { fs.appendFileSync(LOGF, String(m) + '\n'); } catch {} console.log(m); };
const proc = spawn(path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--remote-debugging-port=9243'],
  { cwd: process.cwd(), env: { ...process.env, BLUEWING_DATA_DIR: DATA_DIR }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9243/json')).json();
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
  await sleep(1500);
  const clickText = (txt) => ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.replace(/\\s+/g,'').includes('${txt}')&&b.offsetParent!==null); b?.click(); return !!b; })()`);
  const btnMetrics = `(() => {
    const btns = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null && /^(取消|保存(节点|配置|账号))$/.test(b.textContent.trim()));
    return JSON.stringify(btns.map(b => {
      const cs = getComputedStyle(b);
      const r = b.getBoundingClientRect();
      return { t: b.textContent.trim(), h: Math.round(r.height), bg: cs.backgroundColor, border: cs.borderTopWidth + ' ' + cs.borderTopColor, fw: cs.fontWeight };
    }));
  })()`;
  const focusAll = `(() => {
    // 弹窗面板(.vpn-surface 或 ModalShell 面板)内的全部可聚焦输入控件
    const panel = document.querySelector('.vpn-surface [role="dialog"], .vpn-editor, form.w-full') || document.body;
    const ctrls = [...panel.querySelectorAll('input:not([type=checkbox]):not([type=radio]), textarea, select')].filter(x => x.offsetParent !== null);
    const out = [];
    for (const c of ctrls.slice(0, 12)) {
      c.focus();
      const cs = getComputedStyle(c);
      out.push({ tag: c.tagName.toLowerCase(), ph: (c.placeholder || c.getAttribute('aria-label') || '').slice(0, 12),
        border: cs.borderColor, shadow: cs.boxShadow.slice(0, 64) });
    }
    return JSON.stringify(out);
  })()`;

  // 1. corporate VPN 编辑器(与既往成功烟测同路径)
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='VPN 接入')?.click()`);
  await sleep(900);
  await clickText('添加接入'); await sleep(500);
  await clickText('EasyConnect'); await sleep(1000);
  _log('CORP footer: ' + await ev(btnMetrics));
  _log('CORP focus: ' + await ev(focusAll));
  await clickText('取消'); await sleep(900);

  // 2. engine VPN 编辑器
  await clickText('添加接入'); await sleep(500);
  await clickText('IKEv2'); await sleep(1000);
  _log('ENGINE footer: ' + await ev(btnMetrics));
  _log('ENGINE focus: ' + await ev(focusAll));
  // 3. 节点编辑弹窗(基准,最后;关弹窗后无需再导航)
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='节点')?.click()`);
  await sleep(800);
  await clickText('添加节点'); await sleep(1000);
  _log('NODE footer: ' + await ev(btnMetrics));
  _log('NODE focus: ' + await ev(focusAll));
  await ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
  await clickText('取消'); await sleep(700);
  // 诊断:dump 取消后的可见按钮与弹窗状态
  _log('after-cancel state: ' + await ev(`JSON.stringify({
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    confirmText: [...document.querySelectorAll('button')].filter(b=>b.offsetParent!==null&&/^\u786e\u5b9a$/.test(b.textContent.trim())).length,
    visibleBtns: [...document.querySelectorAll('button')].filter(b=>b.offsetParent!==null).map(b=>b.textContent.trim().slice(0,10)).filter(t=>t).slice(-10)
  })`));
  await clickText('确定'); await sleep(900);
  _log('after-confirm state: ' + await ev(`JSON.stringify({
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    visibleBtns: [...document.querySelectorAll('button')].filter(b=>b.offsetParent!==null).map(b=>b.textContent.trim().slice(0,10)).filter(t=>t).slice(-8)
  })`));

  proc.kill();
  process.exit(0);
})().catch((e) => { _log('ERR ' + e.message); try { proc.kill(); } catch {} process.exit(1); });
