import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { resolveDataDir } from '../main/system/DataDirResolver';

function tmpDir(name: string): string {
  const dir = path.join(__dirname, '.datadir-tmp', name + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dirs: string[]) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
}

describe('DataDirResolver', () => {
  test('portable dir writable with existing database -> portable wins', () => {
    const portable = tmpDir('p1');
    const fallback = tmpDir('f1');
    try {
      fs.writeFileSync(path.join(portable, 'bluewing.json'), '{}');
      const r = resolveDataDir(portable, fallback, () => true);
      assert.equal(r.dir, portable);
      assert.equal(r.migrated, false);
    } finally { cleanup([portable, fallback]); }
  });

  test('portable writable but empty, fallback has data -> forward-migrate into portable and remove fallback', () => {
    const portable = tmpDir('p2');
    const fallback = tmpDir('f2');
    try {
      fs.writeFileSync(path.join(fallback, 'bluewing.json'), '{"schemaVersion":2}');
      fs.mkdirSync(path.join(fallback, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(fallback, 'rules', 'geosite-cn.srs'), 'x');
      fs.mkdirSync(path.join(fallback, 'Cache'), { recursive: true });
      fs.writeFileSync(path.join(fallback, 'Cache', 'c.dat'), 'x');
      const r = resolveDataDir(portable, fallback, () => true);
      assert.equal(r.dir, portable, 'data follows install location');
      assert.equal(r.migrated, true);
      assert.ok(fs.existsSync(path.join(portable, 'bluewing.json')), 'database migrated');
      assert.ok(fs.existsSync(path.join(portable, 'rules', 'geosite-cn.srs')), 'rules migrated');
      assert.ok(fs.existsSync(path.join(portable, 'Cache', 'c.dat')), 'chromium profile migrated');
      assert.ok(!fs.existsSync(fallback), 'fallback dir removed after successful migration');
    } finally { cleanup([portable, fallback]); }
  });

  test('portable unwritable, fallback empty, portable has data -> stranded migration to fallback', () => {
    const portable = tmpDir('p3');
    const fallback = tmpDir('f3');
    try {
      fs.writeFileSync(path.join(portable, 'bluewing.json'), '{"schemaVersion":2}');
      fs.writeFileSync(path.join(portable, 'bluewing.json.bak'), '{}');
      fs.mkdirSync(path.join(portable, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(portable, 'rules', 'geosite-cn.srs'), 'x');
      const r = resolveDataDir(portable, fallback, () => false);
      assert.equal(r.dir, fallback);
      assert.equal(r.migrated, true, 'migration must run');
      assert.ok(fs.existsSync(path.join(fallback, 'bluewing.json')), 'database migrated');
      assert.ok(fs.existsSync(path.join(fallback, 'bluewing.json.bak')), 'bak migrated');
      assert.ok(fs.existsSync(path.join(fallback, 'rules', 'geosite-cn.srs')), 'rules migrated');
    } finally { cleanup([portable, fallback]); }
  });

  test('portable unwritable, fallback already has data -> no migration (fallback is live store)', () => {
    const portable = tmpDir('p4');
    const fallback = tmpDir('f4');
    try {
      fs.writeFileSync(path.join(portable, 'bluewing.json'), '{}');
      fs.writeFileSync(path.join(fallback, 'bluewing.json'), '{}');
      const r = resolveDataDir(portable, fallback, () => false);
      assert.equal(r.dir, fallback);
      assert.equal(r.migrated, false, 'live fallback store must not be re-migrated');
    } finally { cleanup([portable, fallback]); }
  });

  test('portable unwritable, both empty -> plain fallback', () => {
    const portable = tmpDir('p5');
    const fallback = tmpDir('f5');
    try {
      const r = resolveDataDir(portable, fallback, () => false);
      assert.equal(r.dir, fallback);
      assert.equal(r.migrated, false);
      assert.ok(fs.existsSync(fallback), 'fallback dir created');
    } finally { cleanup([portable, fallback]); }
  });

  test('migration failure (source unreadable) -> falls back without migrated flag', () => {
    const portable = tmpDir('p6');
    const fallback = tmpDir('f6');
    try {
      // 便携目录声称有数据库但实际不可访问:解析不应抛异常
      const r = resolveDataDir(portable, fallback, () => false);
      assert.equal(r.dir, fallback);
      assert.equal(r.migrated, false);
    } finally { cleanup([portable, fallback]); }
  });
});
