'use strict';

/**
 * Installs this launcher can verify before running them (src/install-verify.js,
 * the installer's npm path) and the ones it cannot (vendor scripts), plus the
 * launcher's own self-update (update-check.js verifiedUpdate).
 *
 * Nothing is downloaded or installed: npm and every child process are stood in
 * for, HOME is a temp dir, and the "tarballs" are a few bytes written here.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.OPENAGENTS_UNATTENDED;

const iv = require('../src/install-verify');
const { Installer } = require('../src/installer');
const { verifiedUpdate } = require('../src/update-check');

const CLI = path.join(__dirname, '..', 'bin', 'agent-connector.js');
const sri = (buf) => `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;
const GOOD = Buffer.from('the package as published');
const EVIL = Buffer.from('the package with something added');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-')); });
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.OPENAGENTS_UNATTENDED;
});

// ---------------------------------------------------------------------------

describe('the shipped catalog', () => {
  const catalog = require('../registry.json');

  it('pins every npm-installed runtime to an exact version and its sha512', () => {
    const npmTypes = [];
    for (const entry of catalog) {
      for (const plat of ['macos', 'linux', 'windows']) {
        const parsed = iv.parseNpmInstall(entry.install && entry.install[plat]);
        if (!parsed) continue;
        npmTypes.push(entry.name);
        const inst = entry.install;
        assert.equal(inst.npm_package, parsed.pkg, `${entry.name}: npm_package names the package its command installs`);
        assert.match(inst.npm_version, /^\d+\.\d+\.\d+(-[\w.]+)?$/, `${entry.name}: exact version`);
        assert.ok(iv.isSha512Integrity(inst.npm_integrity), `${entry.name}: sha512 integrity`);
        if (parsed.spec && parsed.spec !== 'latest') assert.equal(parsed.spec, inst.npm_version, `${entry.name}: the command's pin is the pin`);
        if (inst.supported_version) assert.equal(inst.supported_version, inst.npm_version, `${entry.name}: supported_version is the pin`);
        const route = iv.installRoute(entry, plat);
        assert.equal(route.verified, true, `${entry.name} on ${plat}`);
        assert.equal(route.command, `npm install -g ${inst.npm_package}@${inst.npm_version}`);
      }
    }
    assert.ok(new Set(npmTypes).size >= 10);
  });

  it('classifies vendor scripts and hand setups as unverified', () => {
    for (const name of ['cursor', 'hermes', 'goose', 'aider', 'amp', 'antigravity', 'codearts', 'openworker', 'mini-swe-agent']) {
      const route = iv.installRoute(catalog.find((e) => e.name === name), 'linux');
      assert.equal(route.verified, false, name);
      assert.ok(route.command, name);
    }
    assert.equal(iv.installRoute(catalog.find((e) => e.name === 'nanoclaw'), 'linux').kind, 'manual');
  });

  it('trusts a pin only when it is the shipped one', () => {
    const claude = catalog.find((e) => e.name === 'claude');
    const other = `sha512-${'A'.repeat(86)}==`;
    assert.equal(iv.installRoute({ ...claude, install: { ...claude.install, npm_integrity: other } }, 'linux').verified, false);
    assert.equal(iv.installRoute({ ...claude, install: { ...claude.install, npm_version: '0.0.1' } }, 'linux').verified, false);
    assert.equal(iv.installRoute({ ...claude, install: { ...claude.install, linux: 'curl https://x.example | sh' } }, 'linux').verified, false);
    const served = { name: 'served-only', install: { linux: 'npm install -g served-only', npm_package: 'served-only', npm_version: '1.0.0', npm_integrity: other } };
    assert.equal(iv.installRoute(served, 'linux').verified, false);
    assert.equal(iv.installRoute({ name: 'x', install: { api_only: true } }, 'linux').verified, true);
  });
});

describe('verifyFileIntegrity', () => {
  it('matches only the sha512 of the exact bytes', () => {
    const file = path.join(dir, 'p.tgz');
    fs.writeFileSync(file, GOOD);
    assert.equal(iv.verifyFileIntegrity(file, sri(GOOD)).ok, true);
    assert.equal(iv.verifyFileIntegrity(file, `sha1-abc ${sri(GOOD)}`).ok, true);
    const bad = iv.verifyFileIntegrity(file, sri(EVIL));
    assert.equal(bad.ok, false);
    assert.equal(bad.actual, sri(GOOD));
    assert.equal(iv.verifyFileIntegrity(file, 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=').ok, false, 'no sha512, no verification');
    assert.equal(iv.verifyFileIntegrity(file, '').ok, false);
  });
});

// ---------------------------------------------------------------------------

/** An Installer over one fake entry, with npm and spawn stood in for. */
function fakeInstaller(entry, { packBytes = GOOD } = {}) {
  const registry = { getEntry: (n) => (n === entry.name ? entry : null) };
  const configDir = path.join(dir, '.openagents');
  const inst = new Installer(registry, configDir);
  inst._shippedInstall = () => entry.install; // this fake entry is "the shipped one"
  inst.hasNodejs = () => true;
  inst._bootstrapManagedUv = async () => {};
  inst._findPostinstallStub = () => null;
  const record = { packs: [], spawns: [], shells: [] };
  inst._runNpm = async (args, { cwd }) => {
    record.packs.push(args);
    fs.writeFileSync(path.join(cwd, `${entry.name}-1.0.0.tgz`), packBytes);
    return { code: 0, stdout: '', stderr: '' };
  };
  inst._execShell = async (cmd) => { record.shells.push(cmd); return 'ok'; };
  return { inst, record, configDir };
}

/** child_process.spawn stood in for the length of `body`: records, exits 0. */
async function withFakeSpawn(record, body) {
  const cp = require('child_process');
  const { EventEmitter } = require('events');
  const real = cp.spawn;
  cp.spawn = (file, args) => {
    record.spawns.push([file, ...(args || [])].join(' '));
    const proc = new EventEmitter();
    const stream = () => { const e = new EventEmitter(); e.setEncoding = () => {}; return e; };
    proc.stdout = stream(); proc.stderr = stream(); proc.pid = 99999;
    setImmediate(() => proc.emit('close', 0));
    return proc;
  };
  try { return await body(); } finally { cp.spawn = real; }
}

const pinned = (integrity) => ({
  name: 'fakeagent',
  label: 'Fake Agent',
  install: {
    binary: 'oa-fake-agent-binary-xyz',
    npm_package: 'fakeagent', npm_version: '1.0.0', npm_integrity: integrity,
    macos: 'npm install -g fakeagent', linux: 'npm install -g fakeagent', windows: 'npm install -g fakeagent',
  },
});
const scripted = {
  name: 'scripty',
  label: 'Scripty',
  install: { binary: 'oa-scripty-binary-xyz', macos: 'curl -fsSL https://vendor.example/install.sh | sh', linux: 'curl -fsSL https://vendor.example/install.sh | sh', windows: 'irm https://vendor.example/install.ps1 | iex' },
};

describe('installer: verified npm installs', () => {
  it('refuses a tampered tarball (hash mismatch) and installs nothing', async () => {
    const { inst, record } = fakeInstaller(pinned(sri(GOOD)), { packBytes: EVIL });
    await withFakeSpawn(record, async () => {
      await assert.rejects(() => inst.installStreaming('fakeagent', () => {}), (e) => {
        assert.equal(e.code, 'INSTALL_INTEGRITY');
        assert.match(e.message, /does not match the checksum/);
        assert.match(e.message, /Nothing was installed/);
        return true;
      });
      await assert.rejects(() => inst.install('fakeagent'), /does not match the checksum/);
    });
    assert.equal(record.packs.length, 2);
    assert.deepEqual(record.spawns, [], 'npm install never ran');
    assert.deepEqual(record.shells, []);
    assert.equal(inst.isInstalled('fakeagent'), false);
    const stash = inst._verifiedStash('fakeagent');
    assert.deepEqual(fs.existsSync(stash) ? fs.readdirSync(stash) : [], [], 'the bad tarball is not kept');
  });

  it('installs the exact tarball it checked, never the registry name', async () => {
    const { inst, record } = fakeInstaller(pinned(sri(GOOD)));
    await withFakeSpawn(record, () => inst.installStreaming('fakeagent', () => {}));
    assert.deepEqual(record.packs[0].slice(0, 3), ['pack', 'fakeagent@1.0.0', '--ignore-scripts']);
    assert.equal(record.spawns.length, 1);
    const kept = path.join(inst._verifiedStash('fakeagent'), 'fakeagent-1.0.0.tgz');
    assert.ok(record.spawns[0].includes(kept), record.spawns[0]);
    assert.ok(!/\sfakeagent(@\S*)?(\s|$)/.test(record.spawns[0].replace(kept, '')), 'no registry spec on the command line');
    assert.equal(fs.readFileSync(kept).equals(GOOD), true);
    assert.equal(inst.isInstalled('fakeagent'), true);

    // install() (no live log) takes the same route.
    const again = fakeInstaller(pinned(sri(GOOD)));
    again.inst.finishNpmInstall = async () => null;
    await again.inst.install('fakeagent');
    assert.ok(again.record.shells[0].includes(path.join(again.inst._verifiedStash('fakeagent'), 'fakeagent-1.0.0.tgz')));
  });

  it('does not bootstrap an unchecked Node.js download for a run that may not run unverified code', async () => {
    const { inst, record } = fakeInstaller(pinned(sri(GOOD)));
    inst.hasNodejs = () => false;
    let bootstrapped = false;
    inst.installNodejs = async () => { bootstrapped = true; };
    await assert.rejects(() => inst.installStreaming('fakeagent', () => {}, { allowUnverified: false }), /needs Node\.js/);
    assert.equal(bootstrapped, false);
    assert.deepEqual(record.packs, []);
  });
});

describe('installer: routes nobody can verify', () => {
  it('refused locally without the go-ahead, with what to run instead', async () => {
    const { inst, record } = fakeInstaller(scripted);
    await withFakeSpawn(record, async () => {
      await assert.rejects(() => inst.installStreaming('scripty', () => {}, { allowUnverified: false }), (e) => {
        assert.equal(e.code, 'INSTALL_UNVERIFIED');
        assert.match(e.message, /agn install scripty --allow-unverified/);
        assert.match(e.message, /curl -fsSL https:\/\/vendor\.example\/install\.sh \| sh/);
        return true;
      });
    });
    assert.deepEqual(record.spawns, []);
  });

  it('allowed locally with the go-ahead', async () => {
    const { inst, record } = fakeInstaller(scripted);
    await withFakeSpawn(record, () => inst.installStreaming('scripty', () => {}, { allowUnverified: true }));
    assert.equal(record.spawns.length, 1);
    assert.match(record.spawns[0], /vendor\.example/);
  });

  it('never under the daemon (remote or unattended), whatever the call asks', async () => {
    process.env.OPENAGENTS_UNATTENDED = '1';
    const { inst, record } = fakeInstaller(scripted);
    await withFakeSpawn(record, async () => {
      await assert.rejects(() => inst.installStreaming('scripty', () => {}, { allowUnverified: true }), /not run for a remote or unattended request/);
      await assert.rejects(() => inst.install('scripty', { allowUnverified: true }), /cannot verify/);
    });
    assert.deepEqual(record.spawns, []);
    assert.deepEqual(record.shells, []);
  });

  it('refuses an agent type that is a path', async () => {
    const { inst } = fakeInstaller({ ...scripted, name: '../escape' });
    await assert.rejects(() => inst.installStreaming('../escape', () => {}, { allowUnverified: true }), /not an agent type/);
  });
});

// ---------------------------------------------------------------------------

describe('agn install (CLI)', () => {
  /** A catalog the launcher fetched from a server, listing one scripted type. */
  function cliEnv(marker, extra = {}) {
    const configDir = path.join(dir, 'cfg');
    fs.mkdirSync(configDir, { recursive: true });
    const cmd = `node -e "require('fs').writeFileSync(process.argv[1], 'ran')" "${marker}"`;
    fs.writeFileSync(path.join(configDir, 'agent_catalog.json'), JSON.stringify([
      { name: 'served-script', label: 'Served Script', install: { binary: 'oa-served-script-xyz', macos: cmd, linux: cmd, windows: cmd } },
    ]));
    const env = { ...process.env, HOME, USERPROFILE: HOME, OPENAGENTS_SKIP_UPDATE_CHECK: '1', ...extra };
    if (!extra.OPENAGENTS_UNATTENDED) delete env.OPENAGENTS_UNATTENDED;
    return { configDir, env };
  }
  const run = (env, ...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 60000 }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  };

  it('refuses an unverified install without --allow-unverified, and under the daemon even with it', () => {
    const marker = path.join(dir, 'ran.txt');
    let { configDir, env } = cliEnv(marker);
    let r = run(env, 'install', 'served-script', '--config', configDir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /agn install served-script --allow-unverified/);
    assert.equal(fs.existsSync(marker), false);

    ({ configDir, env } = cliEnv(marker, { OPENAGENTS_UNATTENDED: '1' }));
    r = run(env, 'install', 'served-script', '--allow-unverified', '--config', configDir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /started by the OpenAgents daemon/);
    assert.equal(fs.existsSync(marker), false);
  });

  it('runs it locally with --allow-unverified', () => {
    const marker = path.join(dir, 'ran.txt');
    const { configDir, env } = cliEnv(marker);
    const r = run(env, 'install', 'served-script', '--allow-unverified', '--config', configDir);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'ran', r.out);
  });

  it('agn update refuses to run under the daemon', () => {
    const { env } = cliEnv(path.join(dir, 'unused'), { OPENAGENTS_UNATTENDED: '1' });
    const r = run(env, 'update', '--version', '9.9.9');
    assert.equal(r.code, 1);
    assert.match(r.out, /Refused/);
  });
});

// ---------------------------------------------------------------------------

describe('agn update: verifiedUpdate', () => {
  const meta = (integrity) => async (version) => ({ version, integrity, tarball: 'https://registry.example/x.tgz' });
  const pack = (bytes) => ({ dir: into }) => { const f = path.join(into, 'agent-launcher-9.9.9.tgz'); fs.writeFileSync(f, bytes); return f; };

  it('installs the tarball only when it matches the registry\'s sha512', async () => {
    const installed = [];
    const ok = await verifiedUpdate({
      version: '9.9.9', fetchMeta: meta(sri(GOOD)), pack: pack(GOOD), runUpdate: (o) => { installed.push(o.tarball); return true; },
    });
    assert.deepEqual(ok, { ok: true, integrity: sri(GOOD) });
    assert.equal(installed.length, 1);
    assert.match(installed[0], /agent-launcher-9\.9\.9\.tgz$/);
  });

  it('refuses a tampered tarball', async () => {
    let ran = false;
    const res = await verifiedUpdate({
      version: '9.9.9', fetchMeta: meta(sri(GOOD)), pack: pack(EVIL), runUpdate: () => { ran = true; return true; },
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /does not match its checksum/);
    assert.equal(ran, false);
  });

  it('refuses when the checksum given disagrees with the registry, or there is none, or no exact version', async () => {
    let ran = false;
    const runUpdate = () => { ran = true; return true; };
    let res = await verifiedUpdate({ version: '9.9.9', integrity: sri(EVIL), fetchMeta: meta(sri(GOOD)), pack: pack(GOOD), runUpdate });
    assert.match(res.error, /not what the registry publishes/);
    res = await verifiedUpdate({ version: '9.9.9', fetchMeta: meta(null), pack: pack(GOOD), runUpdate });
    assert.match(res.error, /no sha512 checksum/);
    res = await verifiedUpdate({ version: 'latest', fetchMeta: meta(sri(GOOD)), pack: pack(GOOD), runUpdate });
    assert.match(res.error, /not an exact version/);
    res = await verifiedUpdate({ version: '9.9.9', fetchMeta: async () => null, pack: pack(GOOD), runUpdate });
    assert.match(res.error, /could not read/);
    assert.equal(ran, false);
  });
});
