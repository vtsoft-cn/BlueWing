import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProxyLifecycle } from '../main/system/ProxyLifecycle';
import { SystemProxy } from '../main/system/SystemProxy';
import { WinInetProxy } from '../main/system/WinInetProxy';
import { LogManager } from '../main/log/LogManager';

test('proxy lifecycle invalidates old enables on stop, preference changes and core replacement', async () => {
  let pid = 1, running = true, enabled = true;
  const attempts: Array<{ port: number; current: () => boolean }> = [];
  let restored = 0, recovered = 0;
  const lifecycle = new ProxyLifecycle({ running: () => running, pid: () => pid },
    () => ({ systemProxyEnabled: enabled, mixedPort: 2080, systemProxyBypassLan: true }), {
      enable: async (_host, port, _bypass, _custom, current) => { attempts.push({ port: port!, current: current! }); return true; },
      restoreOriginal: async () => { restored++; return true; },
      recoverIfUnavailable: async () => { recovered++; return true; },
    });
  await lifecycle.configured({ inbounds: [{ type: 'mixed', listen_port: 2081 }] });
  assert.equal(attempts[0].current(), true);
  enabled = false;
  assert.equal(attempts[0].current(), false);
  await lifecycle.configured({});
  assert.equal(restored, 1);
  enabled = true; pid = 2;
  await lifecycle.configured({});
  assert.equal(attempts[0].current(), false);
  assert.equal(attempts[1].current(), true);
  running = false;
  await lifecycle.unavailable();
  assert.equal(attempts[1].current(), false);
  assert.equal(recovered, 1);
  await lifecycle.stop();
  assert.equal(restored, 2);
});

test('stop followed by quit restores the original snapshot once, including PAC', async t => {
  let state: any = { managedByBlueWing: true, managedServer: '127.0.0.1:2080', originalSnapshot: { enabled: false, connections: [{ name: '', flags: 5, server: '', pac: 'https://office.example/proxy.pac', bypass: '' }] } };
  const requests: any[] = [];
  t.mock.method(SystemProxy as any, 'loadOwnership', () => structuredClone(state));
  t.mock.method(SystemProxy as any, 'saveOwnership', (next: any) => { state = structuredClone(next); return true; });
  t.mock.method(WinInetProxy, 'available', () => true);
  t.mock.method(WinInetProxy, 'run', async (r: any) => { requests.push(r); return []; });
  assert.equal(await SystemProxy.disable(), true);
  assert.equal(await SystemProxy.restoreOriginal(), true);
  assert.deepEqual(requests.map(r => r.action), ['restore']);
  assert.equal(requests[0].connections[0].pac, 'https://office.example/proxy.pac');
});

test('a failed restoration retains ownership and a later retry can restore it', async t => {
  let state: any = { managedByBlueWing: true, managedServer: '127.0.0.1:2080', originalSnapshot: { enabled: false, connections: [] } }, fail = true;
  t.mock.method(SystemProxy as any, 'loadOwnership', () => structuredClone(state));
  t.mock.method(SystemProxy as any, 'saveOwnership', (next: any) => { state = structuredClone(next); return true; });
  t.mock.method(LogManager, 'getInstance', () => ({ addLog() {} }));
  t.mock.method(WinInetProxy, 'available', () => true);
  t.mock.method(WinInetProxy, 'run', async () => { if (fail) throw new Error('native write failed'); return []; });
  assert.equal(await SystemProxy.disable(), false);
  assert.equal(state.managedByBlueWing, true);
  fail = false;
  assert.equal(await SystemProxy.restoreOriginal(), true);
  assert.equal(state, null);
});

test('crash cleanup is serialized behind a pending enable and rechecks native listener ownership', async t => {
  const requests: string[] = [];
  let finishEnable!: () => void, markEnabled!: () => void;
  const entered = new Promise<void>(r => markEnabled = r), pendingEnable = new Promise<void>(r => finishEnable = r);
  t.mock.method(SystemProxy, 'initializeRecovery', async () => true);
  t.mock.method(SystemProxy, 'captureOriginalSnapshot', async () => ({ enabled: false }));
  t.mock.method(SystemProxy as any, 'saveOwnership', () => true);
  t.mock.method(SystemProxy as any, 'getStateFilePath', () => 'isolated-owner.json');
  t.mock.method(LogManager, 'getInstance', () => ({ addLog() {} }));
  t.mock.method(WinInetProxy, 'available', () => true);
  t.mock.method(WinInetProxy, 'run', async (r: any) => {
    requests.push(r.action);
    if (r.action === 'enable') { markEnabled(); await pendingEnable; }
    return [];
  });
  const enabling = SystemProxy.enable();
  await entered;
  const recovery = SystemProxy.recoverIfUnavailable();
  await Promise.resolve();
  assert.deepEqual(requests, ['enable']);
  finishEnable();
  assert.equal(await enabling, true);
  assert.equal(await recovery, true);
  assert.deepEqual(requests, ['enable', 'recover']);
});

test('quit restores after an active WinINet write and blocks later takeovers', async t => {
  const requests: string[] = [];
  let state: any = null;
  let entered!: () => void, release!: () => void;
  const activeWrite = new Promise<void>(resolve => { entered = resolve; });
  const writeGate = new Promise<void>(resolve => { release = resolve; });
  const proxyState = SystemProxy as unknown as { shuttingDown: boolean };
  t.after(() => { proxyState.shuttingDown = false; });
  t.mock.method(SystemProxy, 'initializeRecovery', async () => true);
  t.mock.method(SystemProxy, 'captureOriginalSnapshot', async () => ({ enabled: false }));
  t.mock.method(SystemProxy as any, 'loadOwnership', () => state);
  t.mock.method(SystemProxy as any, 'saveOwnership', (next: any) => { state = next; return true; });
  t.mock.method(LogManager, 'getInstance', () => ({ addLog() {} }));
  t.mock.method(WinInetProxy, 'available', () => true);
  t.mock.method(WinInetProxy, 'run', async (request: any) => {
    requests.push(request.action);
    if (request.action === 'enable') { entered(); await writeGate; }
    return [];
  });

  const enabling = SystemProxy.enable();
  await activeWrite;
  const queued = SystemProxy.enable('127.0.0.1', 2081);
  const quitting = SystemProxy.restoreOnShutdown();
  const late = SystemProxy.enable('127.0.0.1', 2082);
  release();
  assert.equal(await enabling, true);
  assert.equal(await queued, false);
  assert.equal(await quitting, true);
  assert.equal(await late, false);
  assert.deepEqual(requests, ['enable', 'restore']);
  assert.equal(state, null);
});

test('renewed takeover captures external proxy changes and newly created RAS settings', async t => {
  const original = { enabled: false, connections: [{ name: '', flags: 1, server: '', bypass: '', pac: '' }] };
  const lan = { name: '', flags: 3, server: 'user-proxy:8080', bypass: '<local>', pac: '' };
  const ras = { name: 'new-office', flags: 5, server: '', bypass: '', pac: 'https://office.example/proxy.pac' };
  t.mock.method(SystemProxy as any, 'loadOwnership', () => ({ managedByBlueWing: true, managedServer: '127.0.0.1:2080', originalSnapshot: original }));
  t.mock.method(SystemProxy as any, 'getFullRegistryStatus', async () => ({ enabled: true, server: lan.server, connections: [lan, ras] }));
  const captured = await SystemProxy.captureOriginalSnapshot();
  assert.deepEqual(captured.connections, [lan, ras]);
  assert.equal(captured.server, lan.server);
  assert.equal(captured.enabled, true);
});
