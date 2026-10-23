import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { ProfileRepository } from '../main/vpn/ProfileRepository';
import { CorporatePolicy } from '../main/vpn/CorporatePolicy';
import { VpnCoreProcess } from '../main/vpn/VpnCoreProcess';
import { ConfigGenerator } from '../main/core/ConfigGenerator';
import { AppSettings, DnsConfig, ProxyNode } from '../types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listen = (s: net.Server | http.Server, host = '127.0.0.1') =>
  new Promise<number>((resolve) =>
    s.listen(0, host, () => resolve((s.address() as net.AddressInfo).port)),
  );
async function freePort() {
  for (let i = 0; i < 50; i++) {
    const port = 30000 + Math.floor(Math.random() * 12000),
      s = net.createServer();
    const ok = await new Promise<boolean>((r) => {
      s.once('error', () => r(false));
      s.listen(port, '127.0.0.1', () => r(true));
    });
    if (ok) {
      await new Promise<void>((r) => s.close(() => r()));
      return port;
    }
  }
  throw new Error('No test port available');
}
function request(
  proxyPort: number,
  url: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: proxyPort,
        path: url,
        headers: { Host: new URL(url).host },
        agent: false,
      },
      (res) => {
        let body = '';
        res.on('data', (b) => (body += b));
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
        res.on('error', reject);
      },
    );
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
test(
  'Bundled native core and sing-box: company traffic fails closed while public/CN/LAN remain independent',
  { timeout: 30000 },
  async (t) => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bluewing-vpn-integration-'),
    );
    const prior = process.env.BLUEWING_DATA_DIR;
    process.env.BLUEWING_DATA_DIR = dir;
    const sockets = new Set<net.Socket>();
    const servers: net.Server[] = [];
    let core: VpnCoreProcess | undefined;
    let sb: ReturnType<typeof spawn> | undefined;
    t.after(async () => {
      for (const s of sockets) s.destroy();
      for (const server of servers) server.close();
      await core?.stop();
      if (sb) {
        const wait = new Promise((r) =>
          sb!.exitCode !== null ? r(null) : sb!.once('exit', r),
        );
        sb.kill();
        await wait;
      }
      if (prior === undefined) delete process.env.BLUEWING_DATA_DIR;
      else process.env.BLUEWING_DATA_DIR = prior;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    let publicConnections = 0;
    const publicProxy = net.createServer((s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      let stage = 0,
        pending = Buffer.alloc(0),
        targetPort = 0;
      s.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        if (stage === 0) {
          if (pending.length < 2) return;
          const count = pending[1];
          if (pending.length < count + 2) return;
          pending = pending.subarray(count + 2);
          s.write(Buffer.from([5, 0]));
          stage = 1;
        }
        if (stage === 1) {
          if (pending.length < 5) return;
          let end = 0;
          if (pending[3] === 3) end = 5 + pending[4];
          else if (pending[3] === 1) end = 8;
          else if (pending[3] === 4) end = 20;
          else {
            s.destroy();
            return;
          }
          if (pending.length < end + 2) return;
          targetPort = pending.readUInt16BE(end);
          pending = pending.subarray(end + 2);
          s.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          stage = 2;
          publicConnections++;
        }
        if (stage === 2 && pending.length) {
          if (targetPort === 22) {
            s.write(pending);
            pending = Buffer.alloc(0);
          } else if (pending.includes('\r\n\r\n')) {
            const body = 'PUBLIC-ONLY';
            s.end(
              `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
            );
            stage = 3;
          }
        }
      });
    });
    servers.push(publicProxy);
    const publicPort = await listen(publicProxy);
    const local = http.createServer((_, res) => res.end('DIRECT-ONLY'));
    servers.push(local);
    const localPort = await listen(local);
    const mixedPort = await freePort();
    const repo = new ProfileRepository(dir);
    let profile = repo.save({
      id: 'corp-fixture',
      name: 'Fixture',
      protocol: 'easyconnect',
      gateway: { host: 'vpn.example.com', port: 10443 },
      username: 'fixture',
      authMethod: 'auth/psw',
      loginDomain: '',
      rememberPassword: false,
      rememberSession: false,
      tls: {},
      targets: [
        {
          domains: ['dev.corp.example'],
          cidrs: ['127.0.0.2/32'],
          ports: ['80'],
        },
      ],
      hosts: {},
      bindInterface: '',
    });
    // Real native endpoints are bound by their owner; no external EZ4Connect process is used.
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, 'vpn-profiles.json'), 'utf8'),
    );
    raw.profiles[0].socksPort = await freePort();
    raw.profiles[0].dnsPort = await freePort();
    fs.writeFileSync(path.join(dir, 'vpn-profiles.json'), JSON.stringify(raw));
    repo.reload();
    profile = repo.get(profile.id);
    const policy = new CorporatePolicy(dir);
    policy.prepare(repo.list());
    policy.setProbe(profile.id, 'fixture', repo.list());
    const runtime = policy.runtime();
    core = new VpnCoreProcess(path.resolve('bin/bluewing-vpn-core.exe'));
    await core.request('configure', {
      endpoints: runtime.profiles.map((r) => ({
        profile: r.profile,
        user: r.socksUser,
        password: r.socksPassword,
      })),
    });
    const settings = {
      mixedPort,
      systemProxyBypassLan: true,
      tunEnabled: false,
      routingMode: 'rule',
      clashApiEnabled: false,
      dnsCache: false,
      logLevel: 'debug',
    } as AppSettings;
    const dns: DnsConfig = {
      mode: 'fakeip',
      remoteDns: 'udp://127.0.0.1:9',
      directDns: 'udp://127.0.0.1:9',
      fakeIpRange: '198.18.0.0/15',
      enableDnsRouting: true,
      servers: [],
      hosts: [
        { id: 'cn', domain: 'baidu.com', ip: '223.5.5.5', enabled: true },
        {
          id: 'public-fixture',
          domain: 'outside.public.example',
          ip: '198.51.100.23',
          enabled: true,
        },
      ],
    };
    const nodes: ProxyNode[] = [
      {
        id: 'public',
        name: 'Public fixture',
        type: 'socks',
        server: '127.0.0.1',
        port: publicPort,
        groupId: 'test',
      },
    ];
    const config = ConfigGenerator.generate(
      'public',
      nodes,
      [],
      [],
      dns,
      settings,
      undefined,
      runtime,
    );
    // The isolated test uses real predefined CN resolution instead of the all-domain fakeIP rule.
    config.dns.rules = config.dns.rules.filter(
      (r: any) => r.server !== 'fakeip-dns',
    );
    config.inbounds.find((r: any) => r.tag === 'speedtest-in').listen_port =
      await freePort();
    for (const rule of config.route.rules)
      if (rule.outbound === 'direct')
        Object.assign(rule, {
          override_address: '127.0.0.1',
          override_port: localPort,
        });
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify(config));
    const binary = path.resolve('bin/sing-box.exe');
    execFileSync(binary, ['check', '-c', file], {
      windowsHide: true,
      timeout: 5000,
    });
    let log = '';
    sb = spawn(binary, ['run', '-c', file], { windowsHide: true });
    sb.stdout?.on('data', (b) => (log += b));
    sb.stderr?.on('data', (b) => (log += b));
    let publicResponse;
    for (let i = 0; i < 30; i++) {
      try {
        publicResponse = await request(
          mixedPort,
          'http://outside.public.example/',
        );
        break;
      } catch {
        await sleep(100);
      }
    }
    assert.equal(publicResponse?.body, 'PUBLIC-ONLY', log);
    const pid = sb.pid;
    const before = publicConnections;
    for (const url of [
      'http://127.0.0.2/',
      'http://127.0.0.2:9999/',
      'http://dev.corp.example/',
    ]) {
      try {
        const result = await request(mixedPort, url);
        assert.notEqual(result.body, 'PUBLIC-ONLY');
      } catch {
        /* Closed/refused is the expected offline result. */
      }
    }
    assert.equal(
      publicConnections,
      before,
      'company traffic escaped to public selector',
    );
    assert.equal(
      (await request(mixedPort, `http://baidu.com:${localPort}/`)).body,
      'DIRECT-ONLY',
    );
    assert.equal(
      (await request(mixedPort, 'http://223.5.5.5/')).body,
      'DIRECT-ONLY',
    );
    assert.equal(
      (await request(mixedPort, `http://127.0.0.1:${localPort}/`)).body,
      'DIRECT-ONLY',
    );
    assert.equal(
      (await request(mixedPort, 'http://outside.public.example/')).body,
      'PUBLIC-ONLY',
    );
    const updated = repo.save({
      ...profile,
      targets: [
        ...profile.targets,
        { domains: ['new.corp.example'], cidrs: [], ports: ['80'] },
      ],
    });
    policy.update(
      profile.id,
      { targets: [], hosts: {}, dnsServers: [] },
      repo.list(),
    );
    await sleep(600);
    const afterUpdate = publicConnections;
    try {
      await request(mixedPort, 'http://new.corp.example/');
    } catch {}
    assert.equal(
      publicConnections,
      afterUpdate,
      'new company domain escaped during rule update',
    );
    assert.equal(sb.pid, pid);
    assert.equal(sb.exitCode, null);
    assert.equal(
      config.outbounds.find((o: any) => o.tag === 'proxy').default,
      'node-public',
    );
    assert.equal(updated.id, profile.id);
  },
);
