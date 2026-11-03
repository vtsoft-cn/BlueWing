import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { CorporatePolicy } from '../main/vpn/CorporatePolicy';
import { ProfileRepository } from '../main/vpn/ProfileRepository';
import { applyCorporateConfig } from '../main/vpn/CorporateConfig';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const query = Buffer.from([0xb1, 0x01, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 9, 108, 111, 99, 97, 108, 104, 111, 115, 116, 0, 0, 1, 0, 1]);

test('Company DNS uses the same priority, authorization and disconnect rules on real sing-box', { timeout: 30000 }, async t => {
  for (const scenario of [
    { name: 'UDP port restriction', transport: 'udp', allow: false, state: 'active', expected: '' },
    { name: 'UDP allowed owner', transport: 'udp', allow: true, state: 'active', expected: 'alpha' },
    { name: 'UDP failed owner retains guard', transport: 'udp', allow: false, state: 'failed', expected: '' },
    { name: 'UDP explicit disconnect releases owner', transport: 'udp', allow: false, state: 'stopped', expected: 'beta' },
    { name: 'UDP user block precedes company routing', transport: 'udp', allow: true, state: 'active', expected: '', blocked: true },
    { name: 'TCP port restriction', transport: 'tcp', allow: false, state: 'active', expected: '' },
    { name: 'TCP allowed owner', transport: 'tcp', allow: true, state: 'active', expected: 'alpha' },
    { name: 'TCP explicit disconnect releases owner', transport: 'tcp', allow: false, state: 'stopped', expected: 'beta' },
  ]) await t.test(scenario.name, async sub => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewing-dns-priority-'));
    const udp = { alpha: dgram.createSocket('udp4'), beta: dgram.createSocket('udp4') }, client = dgram.createSocket('udp4');
    const sockets = new Set<net.Socket>(), servers: net.Server[] = [];
    const packets: string[] = [], attempts: string[] = [];
    let child: ReturnType<typeof spawn> | undefined, logs = '';
    sub.after(async () => {
      if (child && child.exitCode === null) { const exited = new Promise(r => child!.once('exit', r)); child.kill(); await exited; }
      for (const socket of sockets) socket.destroy();
      for (const server of servers) await new Promise<void>(r => server.close(() => r()));
      udp.alpha.close(); udp.beta.close(); client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const repo = new ProfileRepository(dir), policy = new CorporatePolicy(dir);
    const loopbackInterface = Object.entries(os.networkInterfaces()).find(([, a]) => a?.some(i => i.internal && i.family === 'IPv4'))?.[0];
    const ports: Record<string, number> = {};
    for (const id of ['alpha', 'beta'] as const) {
      await new Promise<void>(r => udp[id].bind(0, '127.0.0.1', r));
      udp[id].on('message', () => packets.push(id));
      const socks = net.createServer(socket => {
        sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
        let buffer = Buffer.alloc(0), stage = 0;
        socket.on('data', data => {
          buffer = Buffer.concat([buffer, data]);
          if (stage === 0 && buffer.length >= 2 + buffer[1]) { buffer = buffer.subarray(2 + buffer[1]); socket.write(Buffer.from([5, 2])); stage = 1; }
          if (stage === 1 && buffer.length >= 3 + buffer[1]) {
            const n = 3 + buffer[1] + buffer[2 + buffer[1]]; if (buffer.length < n) return;
            buffer = buffer.subarray(n); socket.write(Buffer.from([1, 0])); stage = 2;
          }
          if (stage === 2 && buffer.length >= 10) {
            assert.equal(buffer[3], 1);
            assert.equal([...buffer.subarray(4, 8)].join('.'), '10.99.0.53');
            assert.equal(buffer.readUInt16BE(8), 53);
            attempts.push(id); stage = 3;
            socket.end(Buffer.concat([Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]), Buffer.from(id)]));
          }
        });
      }); servers.push(socks);
      await new Promise<void>(r => socks.listen(0, '127.0.0.1', r));
      ports[id] = (socks.address() as net.AddressInfo).port;
      repo.save({ id, name: id, protocol: 'softether', gateway: { host: id + '.example.com', port: 5555 }, loginDomain: 'VPN', username: 'fixture', tls: { trustMode: 'strict' }, routingPriority: id === 'alpha' ? 100 : 200, hosts: {}, targets: [{ domains: [], cidrs: ['10.99.0.53/32'], ...(id === 'alpha' ? { network: scenario.allow ? scenario.transport : 'tcp', ports: [scenario.allow ? '53' : '22'] } : {}) }] });
    }
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'vpn-profiles.json'), 'utf8'));
    for (const p of stored.profiles) p.socksPort = ports[p.id];
    fs.writeFileSync(path.join(dir, 'vpn-profiles.json'), JSON.stringify(stored)); repo.reload();
    for (const id of ['alpha', 'beta'] as const) {
      policy.prepare(repo.list());
      policy.setPacketEndpoint(id, { port: (udp[id].address() as net.AddressInfo).port, publicKey: Buffer.alloc(32, 7).toString('base64'), loopbackInterface }, repo.list());
      policy.begin(id, repo.list()); policy.setProbe(id, 'fixture-probe', repo.list());
    }
    if (scenario.state !== 'active') policy.deactivate(repo.list(), scenario.state === 'failed', 'alpha');
    const portServer = net.createServer(); await new Promise<void>(r => portServer.listen(0, '127.0.0.1', r));
    const port = (portServer.address() as net.AddressInfo).port; await new Promise<void>(r => portServer.close(() => r()));
    const empty = path.join(dir, 'empty.json'); fs.writeFileSync(empty, JSON.stringify({ version: 3, rules: [] }));
    const config: any = {
      log: { level: 'info' },
      inbounds: [{ type: 'direct', tag: 'audit-in', listen: '127.0.0.1', listen_port: port, network: scenario.transport, override_address: '10.99.0.53', override_port: 53 }],
      outbounds: [{ type: 'direct', tag: 'direct' }],
      route: { final: 'direct', default_domain_resolver: 'direct-dns', rules: [{ network: ['tcp', 'udp'], port: [53], action: 'hijack-dns' }, ...(scenario.blocked ? [{ ip_cidr: ['10.99.0.53/32'], action: 'reject' }] : [])], rule_set: ['geosite-cn', 'geoip-cn'].map(tag => ({ type: 'local', tag, format: 'source', path: empty.replace(/\\/g, '/') })) },
      dns: { servers: [{ type: 'udp', tag: 'direct-dns', server: '127.0.0.1', server_port: 9 }], rules: [] },
    };
    applyCorporateConfig(config, policy.runtime());
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
    child = spawn(path.resolve('bin/sing-box.exe'), ['run', '-c', path.join(dir, 'config.json')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', b => logs += b); child.stderr!.on('data', b => logs += b);
    for (let i = 0; i < 40 && !logs.includes('sing-box started') && child.exitCode === null; i++) await sleep(50);
    assert.equal(child.exitCode, null, logs);
    assert.ok(logs.includes('sing-box started'), logs);
    assert.deepEqual(packets, [], 'No business packet should precede the test request');
    if (scenario.transport === 'udp') {
      client.send(query, port, '127.0.0.1'); await sleep(350);
      assert.deepEqual(packets, scenario.expected ? [scenario.expected] : [], logs);
      assert.deepEqual(attempts, []);
    } else {
      const socket = net.createConnection(port, '127.0.0.1'); sockets.add(socket); socket.on('error', () => {});
      let response = '';
      socket.on('data', b => response += b);
      socket.on('connect', () => { const size = Buffer.alloc(2); size.writeUInt16BE(query.length); socket.write(Buffer.concat([size, query])); });
      await Promise.race([new Promise(r => socket.once('close', r)), sleep(1500)]);
      socket.destroy();
      assert.deepEqual(attempts, scenario.expected ? [scenario.expected] : [], logs);
      assert.equal(response, scenario.expected, logs);
      assert.deepEqual(packets, []);
    }
  });
});
