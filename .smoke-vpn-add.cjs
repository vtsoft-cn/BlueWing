// VPN 接入「添加接入」流程烟测:隔离数据目录起 Electron(--remote-debugging-port=9222),
// 经 CDP 驱动页面点击(不动真实鼠标),断言类型选择弹层两条分支:
//   协议引擎类 → 覆盖层内嵌 Vpn 管理组件(回归点:合并前 engineEditorOpen 无渲染块)
//   EasyConnect/aTrust → 打开 corporate 档案编辑器
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(process.env.TEMP, 'bw-smoke-add-' + Date.now());
const electronExe = path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electronExe)) { console.error('NO electron.exe at', electronExe); process.exit(2); }

const proc = spawn(electronExe, ['.', '--remote-debugging-port=9222'], {
  cwd: process.cwd(),
  env: { ...process.env, BLUEWING_DATA_DIR: DATA_DIR },
  stdio: 'ignore',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function findPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9222/json');
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && /BlueWing|index\.html|^file:/i.test(t.title + t.url)) || list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error('CDP target not found');
}

let ws; let msgId = 0; const pending = new Map();
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

// 页内辅助:按可见文本点按钮
const clickByText = `(txt) => {
  const els = [...document.querySelectorAll('button, [role="button"]')];
  const el = els.find((e) => e.textContent.replace(/\\s+/g, '').includes(txt.replace(/\\s+/g, '')) && e.offsetParent !== null);
  if (!el) return false;
  el.click(); return true;
}`;
const q = `(sel) => !!document.querySelector(sel)`;
const textExists = `(txt) => [...document.querySelectorAll('button,strong,h2,h3,span,p')].some((e) => e.offsetParent !== null && e.textContent.includes(txt))`;

async function main() {
  const target = await findPageTarget();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result || m.error); pending.delete(m.id); }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await evalJs(`window.clickByText = ${clickByText}; window.q = ${q}; window.textExists = ${textExists}; (() => { window.__sleep = (ms) => new Promise(r => setTimeout(r, ms)); return 'helpers-ok'; })()`);
  await sleep(1500); // 等首屏渲染

  const step = async (name, fn) => {
    try { const ok = await fn(); results.push([ok ? 'PASS' : 'FAIL', name, ok === true ? '' : String(ok)]); if (!ok) throw new Error('step failed: ' + name); }
    catch (e) { results.push(['FAIL', name, e.message]); throw e; }
  };

  // 1. 侧边栏进 VPN 接入页
  await step('进入 VPN 接入页', async () => {
    await evalJs(`clickByText('VPN 接入')`);
    await evalJs(`__sleep(800)`);
    return evalJs(`textExists('添加你的第一个 VPN 接入') || textExists('接入配置')`);
  });

  // 2. 点添加接入 → 类型选择弹层
  await step('点击添加接入出现类型选择', async () => {
    await evalJs(`clickByText('添加接入') || clickByText('新增接入')`);
    await evalJs(`__sleep(500)`);
    const ok = await evalJs(`q('[aria-label="选择接入类型"]')`);
    if (ok) {
      const ps = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(process.env.TEMP, 'bw-smoke-picker.png'), Buffer.from(ps.data, 'base64'));
    }
    return ok;
  });

  // 3. 类型直选:IKEv2 直开引擎编辑器(回归点:类型弹层直列全部类型)
  await step('点 IKEv2 直开引擎编辑器', async () => {
    await evalJs(`clickByText('IKEv2')`);
    await evalJs(`__sleep(800)`);
    const open = await evalJs(`textExists('添加 VPN 账号')`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.TEMP, 'bw-smoke-overlay.png'), Buffer.from(shot.data, 'base64'));
    return open;
  });

  // 4. X 关闭引擎编辑器
  await step('X 关闭引擎编辑器', async () => {
    await evalJs(`(() => { const h=[...document.querySelectorAll('h3')].find(h=>h.textContent.includes('VPN 账号')); const p=h?.closest('div.rounded-2xl'); p && [...p.querySelectorAll('button')].find(x=>x.querySelector('svg.lucide-x'))?.click(); })()`);
    await evalJs(`__sleep(600)`);
    return evalJs(`!textExists('添加 VPN 账号')`);
  });

  // 6. EasyConnect/aTrust 分支 → corporate 编辑器
  await step('EasyConnect/aTrust 打开编辑器', async () => {
    await evalJs(`clickByText('添加接入') || clickByText('新增接入')`);
    await evalJs(`__sleep(400)`);
    await evalJs(`clickByText('EasyConnect')`);
    await evalJs(`__sleep(800)`);
    return evalJs(`textExists('网关地址') || textExists('认证方式') || textExists('保存')`);
  });

  // 7. 编辑器内自定义下拉:切到高级选项,点开「证书处理方式」,断言 Portal 面板
  await step('证书处理方式为自定义下拉', async () => {
    const shot1 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.TEMP, 'bw-smoke-editor.png'), Buffer.from(shot1.data, 'base64'));
    await evalJs(`document.getElementById('vpn-tab-advanced')?.click()`);
    await evalJs(`__sleep(400)`);
    const opened = await evalJs(`(() => { const b = document.querySelector('button[aria-label="证书处理方式"]'); if (!b) return false; b.click(); return true; })()`);
    await evalJs(`__sleep(400)`);
    const expanded = await evalJs(`document.querySelector('button[aria-label="证书处理方式"]')?.getAttribute('aria-expanded') === 'true'`);
    const panelItems = await evalJs(`[...document.querySelectorAll('button')].filter((b) => b.textContent.includes('严格校验（系统 CA 或已固定指纹）')).length`);
    const shot2 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.TEMP, 'bw-smoke-editor-select.png'), Buffer.from(shot2.data, 'base64'));
    return opened && expanded && panelItems >= 1;
  });

  console.log('=== SMOKE RESULTS ===');
  for (const [st, name, extra] of results) console.log(st, name, extra);
  console.log('ALL PASS');
}

main()
  .catch((e) => {
    console.log('=== SMOKE RESULTS (partial) ===');
    for (const [st, name, extra] of results) console.log(st, name, extra);
    console.error('SMOKE ERROR:', e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    setTimeout(() => process.exit(process.exitCode || 0), 800);
  });
