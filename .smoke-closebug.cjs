// 复现:关到托盘 → 二次启动唤起 → 点 X 关不掉(用户报多次才生效)
const { spawn, execSync } = require('child_process');
const path = require('path');

const DATA_DIR = path.join(process.env.TEMP, 'bw-closebug-' + Date.now());
const electronExe = path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe');
// 第一实例(带调试端口)
const proc = spawn(electronExe, ['.', '--remote-debugging-port=9227'], {
  cwd: process.cwd(),
  env: { ...process.env, BLUEWING_DATA_DIR: DATA_DIR },
  stdio: 'ignore',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9227/json')).json();
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

  const vis = () => ev(`document.visibilityState + (document.hasFocus() ? '|focused' : '|unfocused')`);
  const clickX = (how) => ev(`(() => { try { const how = ${JSON.stringify(how)};
    const b = [...document.querySelectorAll('button')].find(b => b.getAttribute('title') === '关闭' && b.offsetParent !== null);
    if (!b) return 'no button';
    if (how === 'dom') { b.click(); return 'dom-clicked'; }
    const r = b.getBoundingClientRect();
    window.__xrect = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    return 'rect:' + JSON.stringify(window.__xrect);
  } catch (e) { return 'throw: ' + e.message; } })()`);

  // 1) 第一次点 X(DOM)→ 应隐藏进托盘
  console.log('初始可见性:', await vis());
  console.log('按钮探测:', await ev(`(() => {
    try {
      const all = [...document.querySelectorAll('button')];
      const hits = all.filter(b => b.getAttribute('title') === '关闭');
      return JSON.stringify({ total: all.length, hits: hits.length, titles: all.slice(0,3).map(b=>b.getAttribute('title')), headerHtml: document.querySelector('header')?.outerHTML.slice(0,80) || 'no header' });
    } catch (e) { return 'probe-throw: ' + e.message; }
  })()`));
  console.log('点X(DOM):', await clickX('dom'));
  await sleep(900);
  console.log('第一次点X后可见性(应 hidden):', await vis());

  // 2) 二次启动(同数据目录=同单实例锁)→ 唤起已有实例
  const second = spawn(electronExe, ['.'], {
    cwd: process.cwd(),
    env: { ...process.env, BLUEWING_DATA_DIR: DATA_DIR },
    stdio: 'ignore',
  });
  await sleep(4000);
  console.log('二次启动后可见性(应 visible):', await vis(), '第二进程退出码:', second.exitCode);

  // 3) 连点 X(先坐标真实点击,再 DOM 点击),记录每次可见性
  for (let i = 1; i <= 8; i++) {
    const how = i % 2 === 1 ? 'real' : 'dom';
    if (how === 'real') {
      const r = await clickX('rect');
      const m = /{.*}/.exec(r || '');
      if (m) {
        const { x, y } = JSON.parse(m[0]);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
      }
    } else {
      await clickX('dom');
    }
    await sleep(800);
    const v = await vis();
    console.log(`第${i}次点X(${how})后:`, v, 'JS错误:', await ev(`window.__errs.join('|')`));
    if (v.startsWith('hidden')) { console.log(`=> 第 ${i} 次点击才隐藏`); break; }
  }
})()
  .catch((e) => { console.error('ERR', e.message); process.exitCode = 1; })
  .finally(() => { try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch {} setTimeout(() => process.exit(process.exitCode || 0), 600); });
