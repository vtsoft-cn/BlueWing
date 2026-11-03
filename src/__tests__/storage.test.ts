import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { Database } from '../main/db/Database';
import { CredentialSecurity } from '../main/security/CredentialSecurity';
import { ProxyNode, Subscription } from '../types';

const TEST_DB_DIR = path.resolve(__dirname, 'temp_db_storage_test');

function cleanTestDir(): void {
  Database.resetInstance();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

describe('CredentialSecurity', () => {
  test('Encrypts and decrypts strings correctly', () => {
    const raw = 'my-super-secret-password-1234!';
    const encrypted = CredentialSecurity.encrypt(raw);
    assert.ok(encrypted.startsWith('enc:'), 'Encrypted token must start with enc:');
    assert.ok(CredentialSecurity.isEncrypted(encrypted));

    const decrypted = CredentialSecurity.decrypt(encrypted);
    assert.equal(decrypted, raw, 'Decrypted string must match original raw string');
  });

  test('Backward compatibility: returns legacy unencrypted text as-is', () => {
    const legacy = 'plain-text-legacy-password';
    assert.equal(CredentialSecurity.isEncrypted(legacy), false);
    assert.equal(CredentialSecurity.decrypt(legacy), legacy);
  });
});

describe('Database Storage & Recovery', () => {
  beforeEach(() => {
    cleanTestDir();
  });

  afterEach(() => {
    cleanTestDir();
  });

  test('Initializes schema v2 and persists data in isolated directory', () => {
    const db = Database.getInstance(TEST_DB_DIR);
    const nodes: ProxyNode[] = [
      { id: 'test-1', name: 'Node 1', type: 'socks', server: '1.1.1.1', port: 1080, groupId: 'default' },
    ];
    db.saveNodes(nodes);
    db.setActiveNodeId('test-1');
    db.saveSettings({
      webdav: {
        serverUrl: 'https://dav.example.com',
        username: 'user1',
        password: 'mySecretWebDAVPassword',
        remotePath: 'BlueWingConnect',
        autoSync: true,
      },
    });

    const dbFile = path.join(TEST_DB_DIR, 'bluewing.json');
    assert.ok(fs.existsSync(dbFile), 'Database file bluewing.json must exist');

    const raw = fs.readFileSync(dbFile, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.schemaVersion, Database.CURRENT_SCHEMA_VERSION);

    // Verify sensitive password is encrypted on disk
    assert.ok(
      parsed.settings.webdav.password.startsWith('enc:'),
      'WebDAV password must be encrypted on disk'
    );

    // Verify in-memory state provides decrypted password
    assert.equal(
      db.getSettings().webdav.password,
      'mySecretWebDAVPassword',
      'In-memory password must be decrypted'
    );
  });

  test('Debounced save coalesces rapid writes and flushes correctly', async () => {
    const db = Database.getInstance(TEST_DB_DIR);
    const nodes: ProxyNode[] = [
      { id: 'node-a', name: 'Node A', type: 'socks', server: '1.1.1.1', port: 1080, groupId: 'default' },
    ];
    db.saveNodes(nodes);

    // Rapid debounced writes (simulating high-frequency ping updates)
    for (let i = 1; i <= 5; i++) {
      nodes[0].ping = i * 10;
      db.saveDebounced(150);
    }

    // Flush explicitly ensures latest state is on disk immediately
    db.flush();

    const dbFile = path.join(TEST_DB_DIR, 'bluewing.json');
    const raw = fs.readFileSync(dbFile, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.nodes[0].ping, 50, 'Latest debounced update must be written to disk');
  });

  test('Recovers from .bak when main db is corrupted JSON and leaves .corrupted archive', () => {
    const db = Database.getInstance(TEST_DB_DIR);
    const nodes: ProxyNode[] = [
      { id: 'good-node', name: 'Good Node', type: 'socks', server: '1.2.3.4', port: 1080, groupId: 'default' },
    ];
    db.saveNodes(nodes);
    db.flush();

    const dbFile = path.join(TEST_DB_DIR, 'bluewing.json');
    const bakFile = path.join(TEST_DB_DIR, 'bluewing.json.bak');
    assert.ok(fs.existsSync(bakFile), '.bak file must exist');

    // Corrupt the main db file with malformed JSON
    fs.writeFileSync(dbFile, 'INVALID_MALFORMED_JSON_CONTENT{{{', 'utf8');

    // Reinitialize Database instance to trigger load & recovery
    Database.resetInstance();
    const recoveredDb = Database.getInstance(TEST_DB_DIR);

    // Verify data recovered from .bak
    assert.equal(recoveredDb.getNodes().length, 1);
    assert.equal(recoveredDb.getNodes()[0].id, 'good-node');

    // Verify corrupted archive file was created
    const files = fs.readdirSync(TEST_DB_DIR);
    const corruptedArchives = files.filter((f) => f.includes('bluewing.json.corrupted.'));
    assert.ok(corruptedArchives.length > 0, 'Corrupted archive file must be created');
  });

  test('Recovers from .bak when main db file is zero bytes (sudden power loss)', () => {
    const db = Database.getInstance(TEST_DB_DIR);
    const nodes: ProxyNode[] = [
      { id: 'powerloss-node', name: 'Power Node', type: 'socks', server: '5.6.7.8', port: 1080, groupId: 'default' },
    ];
    db.saveNodes(nodes);
    db.flush();

    const dbFile = path.join(TEST_DB_DIR, 'bluewing.json');

    // Simulate sudden power loss right when file was truncated (0 bytes)
    fs.writeFileSync(dbFile, '', 'utf8');
    assert.equal(fs.statSync(dbFile).size, 0);

    // Reinitialize Database
    Database.resetInstance();
    const recoveredDb = Database.getInstance(TEST_DB_DIR);

    assert.equal(recoveredDb.getNodes().length, 1);
    assert.equal(recoveredDb.getNodes()[0].id, 'powerloss-node');
  });

  test('deleteSubscriptionCascade removes subscription and its nodes, falls back active node', () => {
    const db = Database.getInstance(TEST_DB_DIR);
    const mkSub = (id: string): Subscription => ({
      id,
      name: id,
      url: `https://${id}`,
      nodeCount: 0,
      lastUpdate: 0,
      autoUpdate: false,
      updateIntervalHours: 24,
      status: 'idle',
    });
    const mkNode = (id: string, groupId: string): ProxyNode => ({
      id,
      name: id,
      type: 'socks',
      server: `1.1.1.1`,
      port: 1080,
      groupId,
    });

    db.saveSubscriptions([mkSub('sub-a'), mkSub('sub-b')]);
    db.saveNodes([mkNode('n-a1', 'sub-a'), mkNode('n-a2', 'sub-a'), mkNode('n-b1', 'sub-b')]);
    db.setActiveNodeId('n-a2'); // active node belongs to the subscription being deleted

    assert.equal(db.deleteSubscriptionCascade('nonexistent'), false, 'Deleting unknown id must return false');

    assert.equal(db.deleteSubscriptionCascade('sub-a'), true, 'Deleting existing subscription must return true');
    assert.equal(
      db.getSubscriptions().some((s) => s.id === 'sub-a'),
      false,
      'Subscription must be removed'
    );
    assert.equal(
      db.getSubscriptions().some((s) => s.id === 'sub-b'),
      true,
      'Other subscriptions must be kept'
    );
    assert.equal(
      db.getNodes().some((n) => n.groupId === 'sub-a'),
      false,
      'Nodes of the deleted subscription must be cascade-removed'
    );
    assert.equal(
      db.getNodes().some((n) => n.id === 'n-b1'),
      true,
      'Nodes of other subscriptions must be kept'
    );
    assert.equal(db.getActiveNodeId(), 'n-b1', 'Active node must fall back to first remaining node');

    // Verify persistence after reload
    Database.resetInstance();
    const reloaded = Database.getInstance(TEST_DB_DIR);
    assert.equal(reloaded.getSubscriptions().length, 1);
    assert.equal(reloaded.getNodes().length, 1);
    assert.equal(reloaded.getActiveNodeId(), 'n-b1');

    // Deleting the last nodes clears active node id
    assert.equal(reloaded.deleteSubscriptionCascade('sub-b'), true);
    assert.equal(reloaded.getNodes().length, 0, 'All nodes removed when last subscription deleted');
    assert.equal(reloaded.getActiveNodeId(), '', 'Active node id must be empty when no nodes remain');
  });
});

describe('Database Targeted Node Operations', () => {
  beforeEach(() => {
    cleanTestDir();
  });

  afterEach(() => {
    cleanTestDir();
  });

  const mkNode = (id: string): ProxyNode => ({
    id,
    name: id,
    type: 'socks',
    server: '1.1.1.1',
    port: 1080,
    groupId: 'manual',
  });

  test('updateNodeFields patches fields, keeps id immutable, returns false for unknown id', () => {
    const db = Database.getInstance(TEST_DB_DIR);
    db.saveNodes([mkNode('n1'), mkNode('n2')]);
    db.setActiveNodeId('n1');

    assert.equal(db.updateNodeFields('n1', { ping: 42, starred: true, id: 'EVIL' }), true);
    const patched = db.getNodes().find((n) => n.id === 'n1')!;
    assert.equal(patched.ping, 42);
    assert.equal(patched.starred, true);
    assert.equal(patched.id, 'n1', 'Patch must never change node id');
    assert.equal(db.updateNodeFields('missing', { ping: 1 }), false, 'Unknown id must return false');

    // 去抖落盘尚未写盘,重载前必须显式 flush(resetInstance 会丢弃待写定时器)
    db.flush();
    Database.resetInstance();
    const reloaded = Database.getInstance(TEST_DB_DIR);
    assert.equal(reloaded.getNodes().find((n) => n.id === 'n1')?.ping, 42);
  });

  test('bulkUpdateNodeFields applies only matching ids and reports count', () => {
    const db = Database.getInstance(TEST_DB_DIR);
    db.saveNodes([mkNode('n1'), mkNode('n2'), mkNode('n3')]);

    const applied = db.bulkUpdateNodeFields([
      { id: 'n1', patch: { ping: 10 } },
      { id: 'n3', patch: { ping: 30 } },
      { id: 'ghost', patch: { ping: -1 } },
    ]);
    assert.equal(applied, 2, 'Only existing ids count as applied');
    assert.equal(db.getNodes().find((n) => n.id === 'n2')?.ping, undefined);
    assert.equal(db.bulkUpdateNodeFields([]), 0, 'Empty patch list is a no-op');
  });

  test('addNode sets active when list was empty; updateNode replaces by id', () => {
    const db = Database.getInstance(TEST_DB_DIR);
    db.addNode(mkNode('first'));
    assert.equal(db.getActiveNodeId(), 'first', 'First node added to empty list becomes active');

    const edited = { ...mkNode('first'), name: 'renamed', server: '2.2.2.2' };
    assert.equal(db.updateNode(edited), true);
    assert.equal(db.getNodes()[0].name, 'renamed');
    assert.equal(db.getNodes()[0].server, '2.2.2.2');
    assert.equal(db.updateNode(mkNode('missing')), false, 'Updating unknown id must return false');
    assert.equal(db.getActiveNodeId(), 'first', 'Editing a node keeps the active id');
  });

  test('deleteNode falls back active node and clears it when list becomes empty', () => {
    const db = Database.getInstance(TEST_DB_DIR);
    db.saveNodes([mkNode('n1'), mkNode('n2')]);
    db.setActiveNodeId('n2');

    assert.equal(db.deleteNode('n2'), true, 'Deleting active node succeeds');
    assert.equal(db.getActiveNodeId(), 'n1', 'Active falls back to first remaining node');
    assert.equal(db.deleteNode('n2'), false, 'Deleting twice returns false');

    assert.equal(db.deleteNode('n1'), true);
    assert.equal(db.getNodes().length, 0);
    assert.equal(db.getActiveNodeId(), '', 'Active id cleared when no nodes remain');
  });
});
