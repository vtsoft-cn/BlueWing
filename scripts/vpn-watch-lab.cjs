// Isolated, loopback-only experiment against the bundled sing-box. No system proxy/TUN.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server) =>
  new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r(server.address().port)),
  );
async function connect(port, target) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let b = Buffer.alloc(0);
    s.setTimeout(2000, () => s.destroy(new Error('CONNECT timeout')));
    s.on('error', reject);
    s.once('connect', () =>
      s.write(
        `CONNECT 127.0.0.1:${target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`,
      ),
    );
    function data(d) {
      b = Buffer.concat([b, d]);
      if (!b.includes('\r\n\r\n')) return;
      s.off('data', data);
      if (!/^HTTP\/1\.[01] 200 /.test(b.toString())) {
        s.destroy();
        reject(new Error('rejected'));
      } else {
        s.once('data', (echo) => {
          if (echo.toString() !== 'route-probe') {
            s.destroy();
            reject(new Error('probe mismatch'));
            return;
          }
          s.setTimeout(0);
          resolve(s);
        });
        s.write('route-probe');
      }
    }
    s.on('data', data);
    s.on('end', () => reject(new Error('closed')));
  });
}
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewing-watch-'));
  const echo = net.createServer((s) => s.pipe(s));
  const sockets = new Set();
  echo.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  const target = await listen(echo);
  const reserve = net.createServer();
  const port = await listen(reserve);
  await new Promise((r) => reserve.close(r));
  const binary = path.resolve('bin/sing-box.exe');
  const rules = path.join(dir, 'rules.json');
  const source = (ip) =>
    JSON.stringify({ version: 3, rules: ip ? [{ ip_cidr: [ip] }] : [] });
  fs.writeFileSync(rules, source());
  const config = {
    log: { level: 'debug' },
    inbounds: [{ type: 'mixed', listen: '127.0.0.1', listen_port: port }],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: {
      rules: [{ rule_set: ['corp'], action: 'reject' }],
      rule_set: [{ type: 'local', tag: 'corp', format: 'source', path: rules }],
      final: 'direct',
    },
  };
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config));
  execFileSync(binary, ['check', '-c', file], { windowsHide: true });
  const child = spawn(binary, ['run', '-c', file], { windowsHide: true });
  let logs = '';
  child.stdout.on('data', (b) => (logs += b));
  child.stderr.on('data', (b) => (logs += b));
  let held;
  try {
    for (let i = 0; i < 30; i++) {
      try {
        held = await connect(port, target);
        break;
      } catch {
        await sleep(100);
      }
    }
    assert.ok(held, 'core ready: ' + logs);
    const pid = child.pid;
    async function publish(atomic) {
      if (atomic) {
        fs.writeFileSync(rules + '.tmp', source('127.0.0.1/32'));
        fs.renameSync(rules + '.tmp', rules);
      } else fs.writeFileSync(rules, source('127.0.0.1/32'));
      for (let i = 0; i < 40; i++) {
        try {
          (await connect(port, target)).destroy();
        } catch {
          return;
        }
        await sleep(100);
      }
      throw new Error('watcher did not enforce updated CIDR');
    }
    await publish(true);
    const echoed = new Promise((r, j) => {
      const t = setTimeout(() => j(new Error('long connection broken')), 2000);
      held.once('data', (b) => {
        clearTimeout(t);
        r(b.toString());
      });
    });
    held.write('still-alive');
    assert.equal(await echoed, 'still-alive');
    assert.equal(child.pid, pid);
    assert.equal(child.exitCode, null);
    fs.writeFileSync(rules, source());
    await sleep(700);
    (await connect(port, target)).destroy();
    await publish(false);
    fs.writeFileSync(rules, '{broken');
    await sleep(700);
    let invalidPreservesPrevious = false;
    try {
      (await connect(port, target)).destroy();
    } catch {
      invalidPreservesPrevious = true;
    }
    assert.equal(child.exitCode, null);
    const result = {
      version: execFileSync(binary, ['version'], {
        encoding: 'utf8',
        windowsHide: true,
      }).split(/\r?\n/)[0],
      atomicReplace: true,
      inPlace: true,
      invalidPreservesPrevious,
      longConnectionPreserved: true,
      pidUnchanged: true,
      watchLog: logs
        .split(/\r?\n/)
        .filter((l) => /reload|rule-set|watch/i.test(l))
        .slice(-12),
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    held?.destroy();
    for (const s of sockets) s.destroy();
    echo.close();
    child.kill();
    await new Promise((r) =>
      child.exitCode !== null ? r() : child.once('exit', r),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
