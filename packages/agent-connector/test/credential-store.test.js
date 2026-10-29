'use strict';

// The OS credential store and the move of plaintext secrets into it. Every
// backend runs against a mocked spawnSync (no real Keychain, Secret Service or
// PowerShell is touched); the assertions that matter most are that a secret
// never appears in a child's argv and that a working plaintext credential is
// only replaced once the store has given it back.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EnvManager } = require('../src/env');
const policy = require('../src/env-policy');
const fsProtect = require('../src/fs-protect');
const {
  SERVICE, CredentialStoreError, MacKeychainStore, SecretServiceStore, WindowsDpapiStore, NoStore,
  createCredentialStore, resolveMode, PS_PROTECT, PS_UNPROTECT,
} = require('../src/credential-store');

const SECRET = 'sk-dummy-SECRET-MARKER-9876543210';
const ID = '0123456789abcdef0123456789abcdef';
const REF_LINE = /^LLM_API_KEY=@credential:[0-9a-f]{32}$/m;

let tmpDir;
let warnings;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cred-'));
  warnings = [];
  fsProtect._resetForTests();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A spawnSync double that records every call and answers through `reply`. */
function spawnRecorder(reply) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const call = { cmd, args: [...args], input: opts && opts.input };
    calls.push(call);
    return { status: 0, stdout: '', stderr: '', ...(reply(call) || {}) };
  };
  fn.calls = calls;
  return fn;
}

function assertNotInArgv(calls, ...needles) {
  for (const c of calls) {
    for (const a of [c.cmd, ...c.args]) {
      for (const n of needles) assert.ok(!String(a).includes(n), `found in argv: ${a}`);
    }
  }
}

/** An in-memory store with switches for each failure the migration must survive. */
function memoryStore(opts = {}) {
  const data = new Map();
  const events = [];
  return {
    name: 'memory',
    writable: opts.writable !== false,
    quiet: false,
    data,
    events,
    available() { return !opts.unavailable; },
    set(id, secret) {
      events.push(['set', id]);
      if (opts.onSet) opts.onSet(id, secret);
      if (opts.failSet) throw new CredentialStoreError('memory store write failed');
      data.set(id, secret);
    },
    get(id, { noCache } = {}) {
      events.push(['get', id, !!noCache]);
      if (opts.onGet) opts.onGet(id, noCache);
      if (opts.failGet) throw new CredentialStoreError('memory store read failed');
      if (!data.has(id)) return null;
      return opts.mismatch ? `${data.get(id)}-changed` : data.get(id);
    },
    delete(id) {
      events.push(['delete', id]);
      if (opts.onDelete) opts.onDelete(id);
      data.delete(id);
    },
  };
}

function envFile(type = 'codex') {
  return path.join(tmpDir, 'env', `${type}.env`);
}

function writeEnvFile(text, type = 'codex') {
  fs.mkdirSync(path.join(tmpDir, 'env'), { recursive: true });
  fs.writeFileSync(envFile(type), text, { mode: 0o644 });
}

function manager(store) {
  return new EnvManager(tmpDir, { credentialStore: store, warn: (m) => warnings.push(m) });
}

function refOf(text) {
  const m = text.match(/^LLM_API_KEY=@credential:([0-9a-f]{32})$/m);
  return m ? m[1] : null;
}

function assertNoSecretInWarnings() {
  for (const w of warnings) assert.ok(!w.includes(SECRET), `warning leaks the secret: ${w}`);
}

describe('which keys are secrets', () => {
  it('matches the credential names and nothing else', () => {
    for (const k of ['LLM_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'GOOSE_PROVIDER__API_KEY',
      'CODEARTS_CLI_SK', 'CODEARTS_CLI_AK', 'DB_PASSWORD', 'DB_PASSWD', 'AWS_SECRET_ACCESS_KEY', 'GH_TOKEN', 'MY_CREDENTIAL']) {
      assert.equal(policy.isSecretKey(k), true, k);
    }
    for (const k of ['LLM_MODEL', 'LLM_BASE_URL', 'OPENAGENTS_AUTH_MODE', 'CODEX_WIRE_API', 'PI_PROVIDER']) {
      assert.equal(policy.isSecretKey(k), false, k);
    }
  });
});

describe('macOS Keychain backend (security mocked)', () => {
  function keychain(reply, extra = {}) {
    const spawnSync = spawnRecorder(reply);
    return { store: new MacKeychainStore({ spawnSync, exists: () => true, ...extra }), spawnSync };
  }

  it('writes through `security -i` with the secret hex-encoded on stdin only', () => {
    const { store, spawnSync } = keychain(() => ({}));
    store.set(ID, SECRET, { label: 'OpenAgents codex LLM_API_KEY' });
    const [call] = spawnSync.calls;
    assert.equal(call.cmd, '/usr/bin/security');
    assert.deepEqual(call.args, ['-i']);
    const hex = Buffer.from(SECRET, 'utf8').toString('hex');
    assert.ok(call.input.includes(`-X ${hex}`));
    assert.ok(call.input.includes(`-a "${ID}"`) && call.input.includes(`-s "${SERVICE}"`));
    assert.ok(!call.input.includes(SECRET), 'not even stdin carries it in clear');
    assert.ok(call.input.endsWith('\n') && call.input.split('\n').length === 2, 'one command line');
    assertNotInArgv(spawnSync.calls, SECRET, hex);
  });

  it('reads with find-generic-password -w, carrying only the id in argv', () => {
    const { store, spawnSync } = keychain(() => ({ stdout: `${SECRET}\n` }));
    assert.equal(store.get(ID), SECRET);
    assert.deepEqual(spawnSync.calls[0].args, ['find-generic-password', '-a', ID, '-s', SERVICE, '-w']);
  });

  it('caches lookups, except for a read-back', () => {
    const { store, spawnSync } = keychain(() => ({ stdout: `${SECRET}\n` }));
    store.get(ID);
    store.get(ID);
    assert.equal(spawnSync.calls.length, 1);
    store.get(ID, { noCache: true });
    assert.equal(spawnSync.calls.length, 2);
  });

  it('answers null for a missing item and deletes idempotently', () => {
    const { store, spawnSync } = keychain(() => ({ status: 44, stderr: 'The specified item could not be found' }));
    assert.equal(store.get(ID), null);
    store.delete(ID);
    assert.deepEqual(spawnSync.calls[1].args, ['delete-generic-password', '-a', ID, '-s', SERVICE]);
  });

  it('round-trips values `security` would print as hex through a base64 marker', () => {
    let stored = null;
    const { store } = keychain((call) => {
      if (call.args[0] === '-i') {
        stored = Buffer.from(call.input.match(/-X ([0-9a-f]+)/)[1], 'hex').toString('utf8');
        return {};
      }
      return { stdout: `${stored}\n` };
    });
    const value = 'ค่า-ทดสอบ\twith tab';
    store.set(ID, value, {});
    assert.ok(stored.startsWith('oa-b64:'));
    assert.equal(store.get(ID, { noCache: true }), value);
    store.set(ID, 'oa-b64:looks-encoded', {});
    assert.equal(store.get(ID, { noCache: true }), 'oa-b64:looks-encoded');
  });

  it('fails without quoting the secret or the tool\'s output', () => {
    const { store } = keychain(() => ({ status: 36, stderr: `User interaction is not allowed. ${SECRET}` }));
    assert.throws(() => store.set(ID, SECRET, {}), (e) =>
      e instanceof CredentialStoreError && /locked/.test(e.message) && !e.message.includes(SECRET));
    assert.throws(() => store.get(ID), (e) => !e.message.includes(SECRET));
  });

  it('does not retry a failed lookup on every load', () => {
    let now = 1000;
    const spawnSync = spawnRecorder(() => ({ status: 1, stderr: 'boom' }));
    const store = new MacKeychainStore({ spawnSync, exists: () => true, now: () => now });
    assert.throws(() => store.get(ID));
    assert.throws(() => store.get(ID));
    assert.equal(spawnSync.calls.length, 1);
    now += 60000;
    assert.throws(() => store.get(ID));
    assert.equal(spawnSync.calls.length, 2);
  });

  it('refuses a value too long for the command line without running anything', () => {
    // `security -i` cuts a line over 4 KiB and runs the first part, an add
    // whose keychain argument was cut off: it must never see such a line.
    const { store, spawnSync } = keychain(() => ({}));
    assert.throws(() => store.set(ID, 'k'.repeat(2000), {}), { code: 'CREDENTIAL_TOO_LONG' });
    assert.equal(spawnSync.calls.length, 0);
    store.set(ID, 'k'.repeat(1300), { label: 'OpenAgents codex LLM_API_KEY' });
    assert.equal(spawnSync.calls.length, 1);
    assert.ok(Buffer.byteLength(spawnSync.calls[0].input) <= 3000);
  });

  it('rejects ids that are not credential ids', () => {
    const { store, spawnSync } = keychain(() => ({}));
    for (const bad of ['x', '"; rm -rf /', `${ID}\n`, ID.toUpperCase()]) {
      assert.throws(() => store.get(bad), { code: 'CREDENTIAL_ID_INVALID' });
    }
    assert.equal(spawnSync.calls.length, 0);
  });
});

describe('Linux Secret Service backend (secret-tool mocked)', () => {
  const bus = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', PATH: '/usr/bin' };

  function secretTool(reply, env = bus) {
    const spawnSync = spawnRecorder(reply);
    return { store: new SecretServiceStore({ spawnSync, env, secretToolPath: '/usr/bin/secret-tool', exists: () => false }), spawnSync };
  }

  it('stores with the secret on stdin and only attributes in argv', () => {
    const { store, spawnSync } = secretTool(() => ({}));
    store.set(ID, SECRET, { label: 'OpenAgents codex LLM_API_KEY' });
    const [call] = spawnSync.calls;
    assert.equal(call.cmd, '/usr/bin/secret-tool');
    assert.deepEqual(call.args, ['store', '--label=OpenAgents codex LLM_API_KEY', 'service', SERVICE, 'account', ID]);
    assert.equal(call.input, SECRET);
    assertNotInArgv(spawnSync.calls, SECRET);
  });

  it('looks up, and tells "not found" from "no Secret Service"', () => {
    let { store } = secretTool(() => ({ stdout: SECRET }));
    assert.equal(store.get(ID), SECRET);
    ({ store } = secretTool(() => ({ status: 1 })));
    assert.equal(store.get(ID), null);
    ({ store } = secretTool(() => ({ status: 1, stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY' })));
    assert.throws(() => store.get(ID), /no Secret Service/);
  });

  it('is unavailable without secret-tool or a session bus (headless)', () => {
    assert.equal(new SecretServiceStore({ env: bus, secretToolPath: null }).available(), false);
    assert.equal(new SecretServiceStore({ env: { PATH: '/usr/bin' }, secretToolPath: '/usr/bin/secret-tool', exists: () => false }).available(), false);
    assert.equal(new SecretServiceStore({ env: bus, secretToolPath: '/usr/bin/secret-tool' }).available(), true);
    const found = new SecretServiceStore({ env: { PATH: '/opt/bin:/usr/bin', XDG_RUNTIME_DIR: '/run/user/1' }, exists: (p) => p === '/usr/bin/secret-tool' || p === '/run/user/1/bus' });
    assert.equal(found.available(), true);
  });
});

describe('Windows DPAPI backend (PowerShell and icacls mocked)', () => {
  const winEnv = { USERNAME: 'alice', USERDOMAIN: 'CORP', SystemRoot: 'C:\\Windows' };
  const BLOB = '01000000d08c9ddf0115d1118c7a00c04fc297eb0100000000aa';

  function dpapi() {
    const icacls = [];
    const spawnSync = spawnRecorder((call) => {
      const script = Buffer.from(call.args[call.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
      if (script === PS_PROTECT) return { stdout: BLOB };
      if (script === PS_UNPROTECT) return { stdout: Buffer.from(SECRET, 'utf8').toString('base64') };
      return { status: 1 };
    });
    const store = new WindowsDpapiStore({
      spawnSync, configDir: tmpDir, env: winEnv, exists: () => true,
      execFileSync: (cmd, args) => { icacls.push({ cmd, args }); return ''; },
    });
    return { store, spawnSync, icacls };
  }

  it('protects through an encoded script with the secret on stdin, and keeps a user-only blob', () => {
    const { store, spawnSync, icacls } = dpapi();
    store.set(ID, SECRET, { label: 'OpenAgents codex LLM_API_KEY' });
    const [call] = spawnSync.calls;
    assert.match(call.cmd, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
    assert.ok(call.args.includes('-NonInteractive') && call.args.includes('-NoProfile'));
    assert.equal(Buffer.from(call.input, 'base64').toString('utf8'), SECRET);
    const script = Buffer.from(call.args[call.args.length - 1], 'base64').toString('utf16le');
    assert.equal(script, PS_PROTECT);
    assert.ok(!script.includes(SECRET));
    const blobFile = path.join(tmpDir, 'credentials', `${ID}.dpapi`);
    assert.equal(fs.readFileSync(blobFile, 'utf-8').trim(), BLOB);
    assert.ok(icacls.some((c) => c.args.includes('CORP\\alice:(OI)(CI)F')), 'credentials dir restricted');
    assert.ok(icacls.some((c) => c.args.includes('CORP\\alice:F')), 'blob restricted');
    assertNotInArgv([...spawnSync.calls, ...icacls], SECRET, Buffer.from(SECRET, 'utf8').toString('base64'));
  });

  it('unprotects with the blob on stdin and deletes the blob', () => {
    const { store, spawnSync } = dpapi();
    store.set(ID, SECRET, {});
    assert.equal(store.get(ID, { noCache: true }), SECRET);
    const read = spawnSync.calls[1];
    assert.equal(read.input, BLOB);
    assert.equal(Buffer.from(read.args[read.args.length - 1], 'base64').toString('utf16le'), PS_UNPROTECT);
    store.delete(ID);
    assert.equal(fs.existsSync(path.join(tmpDir, 'credentials', `${ID}.dpapi`)), false);
    assert.equal(store.get(ID), null);
  });
});

describe('choosing a store', () => {
  it('uses the platform store by default and never the real one under a test runner', () => {
    assert.equal(createCredentialStore({ platform: 'darwin', env: {}, configDir: tmpDir }).name, 'keychain');
    assert.equal(createCredentialStore({ platform: 'linux', env: {}, configDir: tmpDir }).name, 'secret-service');
    assert.equal(createCredentialStore({ platform: 'win32', env: {}, configDir: tmpDir }).name, 'dpapi');
    assert.equal(createCredentialStore({ platform: 'aix', env: {}, configDir: tmpDir }).name, 'none');
    for (const env of [{ NODE_TEST_CONTEXT: 'child-v8' }, { VITEST: 'true' }, { JEST_WORKER_ID: '1' }, { NODE_ENV: 'test' }]) {
      assert.equal(resolveMode(env), 'off');
      assert.equal(createCredentialStore({ platform: 'darwin', env, configDir: tmpDir }).name, 'none');
    }
    assert.equal(resolveMode(process.env), 'off', 'this very run must not reach the real Keychain');
  });

  it('honours OPENAGENTS_CREDENTIAL_STORE', () => {
    const file = createCredentialStore({ platform: 'darwin', env: { OPENAGENTS_CREDENTIAL_STORE: 'file' }, configDir: tmpDir });
    assert.equal(file.name, 'keychain');
    assert.equal(file.writable, false, 'file: new secrets stay in the env file, references still resolve');
    assert.equal(createCredentialStore({ platform: 'darwin', env: { OPENAGENTS_CREDENTIAL_STORE: 'off' } }).name, 'none');
    assert.equal(createCredentialStore({ platform: 'darwin', env: { OPENAGENTS_CREDENTIAL_STORE: 'secret-service' } }).name, 'secret-service');
    assert.equal(resolveMode({ OPENAGENTS_CREDENTIAL_STORE: 'bogus' }), 'auto');
  });
});

describe('EnvManager with a credential store', () => {
  it('save puts a secret in the store and a reference in the file', () => {
    const store = memoryStore();
    const env = manager(store);
    env.save('codex', { LLM_API_KEY: SECRET, LLM_BASE_URL: 'https://relay.example/v1' });
    const text = fs.readFileSync(envFile(), 'utf-8');
    assert.match(text, REF_LINE);
    assert.match(text, /^LLM_BASE_URL=https:\/\/relay\.example\/v1$/m);
    assert.ok(!text.includes(SECRET));
    assert.equal(store.data.get(refOf(text)), SECRET);
    assert.ok(store.events.some(([op, id, noCache]) => op === 'get' && id === refOf(text) && noCache), 'read back before use');
    assert.deepEqual(env.load('codex'), { LLM_API_KEY: SECRET, LLM_BASE_URL: 'https://relay.example/v1' });
    const forAgent = env.getForAgent('codex', { getResolveRules: () => [{ from: 'LLM_API_KEY', to: 'OPENAI_API_KEY' }] }, {});
    assert.equal(forAgent.OPENAI_API_KEY, SECRET);
  });

  it('round-trips secrets with =, spaces and quotes through the store', () => {
    const store = memoryStore();
    const env = manager(store);
    const value = `${SECRET}= "quoted" and spaced=`;
    env.save('codex', { LLM_API_KEY: value });
    assert.equal(env.load('codex').LLM_API_KEY, value);
  });

  it('keeps the same reference when the same value is saved again', () => {
    const store = memoryStore();
    const env = manager(store);
    env.save('codex', { LLM_API_KEY: SECRET });
    const ref = refOf(fs.readFileSync(envFile(), 'utf-8'));
    // The launcher saves the whole loaded env back with one key changed.
    env.save('codex', { ...env.load('codex'), LLM_MODEL: 'gpt-x' });
    assert.equal(refOf(fs.readFileSync(envFile(), 'utf-8')), ref);
    assert.equal(store.events.filter(([op]) => op === 'set').length, 1);
  });

  it('a new value gets a new entry; the old one goes only after the file points away from it', () => {
    let fileAtDelete = null;
    const store = memoryStore({ onDelete: () => { fileAtDelete = fs.readFileSync(envFile(), 'utf-8'); } });
    const env = manager(store);
    env.save('codex', { LLM_API_KEY: SECRET });
    const oldRef = refOf(fs.readFileSync(envFile(), 'utf-8'));
    env.save('codex', { LLM_API_KEY: `${SECRET}-rotated` });
    const newRef = refOf(fs.readFileSync(envFile(), 'utf-8'));
    assert.notEqual(newRef, oldRef);
    assert.equal(store.data.has(oldRef), false);
    assert.equal(refOf(fileAtDelete), newRef);
    assert.equal(env.load('codex').LLM_API_KEY, `${SECRET}-rotated`);
  });

  it('removing the key or the file removes its store entry', () => {
    const store = memoryStore();
    const env = manager(store);
    env.save('codex', { LLM_API_KEY: SECRET, LLM_MODEL: 'gpt-x' });
    env.save('codex', { LLM_API_KEY: '' });
    assert.equal(store.data.size, 0);
    env.save('codex', { LLM_API_KEY: SECRET });
    env.delete('codex');
    assert.equal(store.data.size, 0);
    assert.equal(fs.existsSync(envFile()), false);
  });

  it('keeps a store entry another env file still refers to', () => {
    const store = memoryStore();
    const env = manager(store);
    env.save('codex', { LLM_API_KEY: SECRET });
    fs.copyFileSync(envFile('codex'), envFile('claude'));
    env.delete('codex');
    assert.equal(env.load('claude').LLM_API_KEY, SECRET);
  });

  it('a secret the store will not take stays in the protected file', () => {
    const store = memoryStore({ failSet: true });
    const env = manager(store);
    env.save('codex', { LLM_API_KEY: SECRET });
    assert.equal(env.load('codex').LLM_API_KEY, SECRET);
    assert.match(fs.readFileSync(envFile(), 'utf-8'), new RegExp(`^LLM_API_KEY=${SECRET}$`, 'm'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(envFile()).mode & 0o777, 0o600);
    assert.ok(warnings.some((w) => w.includes('LLM_API_KEY')));
    assertNoSecretInWarnings();
  });

  it('with OPENAGENTS_CREDENTIAL_STORE=file, saves plaintext but still resolves existing references', () => {
    const store = memoryStore();
    manager(store).save('codex', { LLM_API_KEY: SECRET });
    const readOnly = { ...memoryStore({ writable: false }), data: store.data };
    readOnly.get = store.get;
    const env = manager(readOnly);
    assert.equal(env.load('codex').LLM_API_KEY, SECRET);
    env.save('codex', { GH_TOKEN: 'ghp-dummy' });
    const text = fs.readFileSync(envFile(), 'utf-8');
    assert.match(text, REF_LINE);
    assert.match(text, /^GH_TOKEN=ghp-dummy$/m);
  });

  it('a reference the store cannot resolve is left unset and kept', () => {
    writeEnvFile(`LLM_API_KEY=@credential:${ID}\nLLM_MODEL=gpt-x\n`);
    const env = manager(memoryStore());
    assert.deepEqual(env.load('codex'), { LLM_MODEL: 'gpt-x' });
    assert.ok(warnings.some((w) => w.includes('LLM_API_KEY')));
    env.save('codex', { ...env.load('codex'), LLM_BASE_URL: 'https://relay.example' });
    assert.match(fs.readFileSync(envFile(), 'utf-8'), new RegExp(`^LLM_API_KEY=@credential:${ID}$`, 'm'));
    const failing = manager(memoryStore({ failGet: true }));
    assert.equal(failing.load('codex').LLM_API_KEY, undefined);
  });

  it('nothing in argv: the real Keychain backend class with security mocked', () => {
    const items = new Map();
    const spawnSync = spawnRecorder((call) => {
      if (call.args[0] === '-i') {
        const id = call.input.match(/-a "([0-9a-f]{32})"/)[1];
        items.set(id, Buffer.from(call.input.match(/-X ([0-9a-f]+)/)[1], 'hex').toString('utf8'));
        return {};
      }
      const id = call.args[call.args.indexOf('-a') + 1];
      if (call.args[0] === 'find-generic-password') return items.has(id) ? { stdout: `${items.get(id)}\n` } : { status: 44 };
      items.delete(id);
      return {};
    });
    writeEnvFile(`LLM_API_KEY=${SECRET}\n`);
    const env = manager(new MacKeychainStore({ spawnSync, exists: () => true }));
    assert.equal(env.load('codex').LLM_API_KEY, SECRET);
    assert.match(fs.readFileSync(envFile(), 'utf-8'), REF_LINE);
    env.save('codex', { LLM_API_KEY: `${SECRET}-2` });
    assert.equal(env.load('codex').LLM_API_KEY, `${SECRET}-2`);
    assert.equal(items.size, 1, 'the replaced entry was deleted');
    assertNotInArgv(spawnSync.calls, SECRET, Buffer.from(SECRET).toString('hex'));
  });
});

describe('migrating plaintext secrets of an existing install', () => {
  it('moves them on first load, replacing the file only after a verified read-back', () => {
    writeEnvFile(`LLM_API_KEY=${SECRET}\nLLM_BASE_URL=https://relay.example/v1\n`);
    const fileAtReadBack = [];
    const store = memoryStore({ onGet: (id, noCache) => { if (noCache) fileAtReadBack.push(fs.readFileSync(envFile(), 'utf-8')); } });
    const env = manager(store);
    assert.deepEqual(env.load('codex'), { LLM_API_KEY: SECRET, LLM_BASE_URL: 'https://relay.example/v1' });
    assert.equal(fileAtReadBack.length, 1);
    assert.ok(fileAtReadBack[0].includes(`LLM_API_KEY=${SECRET}`), 'plaintext still in place while verifying');
    const text = fs.readFileSync(envFile(), 'utf-8');
    assert.match(text, REF_LINE);
    assert.match(text, /^LLM_BASE_URL=https:\/\/relay\.example\/v1$/m);
    assert.ok(!text.includes(SECRET));
    if (process.platform !== 'win32') assert.equal(fs.statSync(envFile()).mode & 0o777, 0o600);
  });

  it('is idempotent', () => {
    writeEnvFile(`LLM_API_KEY=${SECRET}\n`);
    const store = memoryStore();
    const env = manager(store);
    env.load('codex');
    const after = fs.readFileSync(envFile(), 'utf-8');
    env.load('codex');
    manager(store).load('codex');
    assert.equal(fs.readFileSync(envFile(), 'utf-8'), after);
    assert.equal(store.events.filter(([op]) => op === 'set').length, 1);
    assert.equal(store.data.size, 1);
  });

  it('keeps the working plaintext when the store write fails, and does not retry every load', () => {
    writeEnvFile(`LLM_API_KEY=${SECRET}\n`);
    const store = memoryStore({ failSet: true });
    const env = manager(store);
    assert.equal(env.load('codex').LLM_API_KEY, SECRET);
    assert.equal(env.load('codex').LLM_API_KEY, SECRET);
    assert.equal(fs.readFileSync(envFile(), 'utf-8'), `LLM_API_KEY=${SECRET}\n`);
    assert.equal(store.events.filter(([op]) => op === 'set').length, 1);
    assert.equal(warnings.filter((w) => w.includes('LLM_API_KEY')).length, 1);
    assertNoSecretInWarnings();
    if (process.platform !== 'win32') assert.equal(fs.statSync(envFile()).mode & 0o777, 0o600);
  });

  it('keeps the working plaintext when the read-back does not match, and removes the bad entry', () => {
    writeEnvFile(`LLM_API_KEY=${SECRET}\n`);
    const store = memoryStore({ mismatch: true });
    const env = manager(store);
    assert.equal(env.load('codex').LLM_API_KEY, SECRET);
    assert.equal(fs.readFileSync(envFile(), 'utf-8'), `LLM_API_KEY=${SECRET}\n`);
    assert.equal(store.data.size, 0);
    assert.ok(store.events.some(([op]) => op === 'delete'));
    assert.ok(warnings.some((w) => w.includes('LLM_API_KEY') && /read back/.test(w)));
    assertNoSecretInWarnings();
  });

  it('keeps the working plaintext when no store is available', () => {
    writeEnvFile(`LLM_API_KEY=${SECRET}\n`);
    const store = memoryStore({ unavailable: true });
    const env = manager(store);
    assert.equal(env.load('codex').LLM_API_KEY, SECRET);
    env.save('codex', { LLM_MODEL: 'gpt-x' });
    assert.match(fs.readFileSync(envFile(), 'utf-8'), new RegExp(`^LLM_API_KEY=${SECRET}$`, 'm'));
    assert.equal(store.events.length, 0);
    if (process.platform !== 'win32') assert.equal(fs.statSync(envFile()).mode & 0o777, 0o600);
  });

  it('backs off when another process changed the file meanwhile, losing neither change', () => {
    writeEnvFile(`LLM_API_KEY=${SECRET}\n`);
    const store = memoryStore({
      onSet: () => fs.writeFileSync(envFile(), `LLM_API_KEY=${SECRET}\nLLM_MODEL=saved-elsewhere\n`),
    });
    const env = manager(store);
    assert.equal(env.load('codex').LLM_API_KEY, SECRET);
    assert.equal(fs.readFileSync(envFile(), 'utf-8'), `LLM_API_KEY=${SECRET}\nLLM_MODEL=saved-elsewhere\n`);
    assert.equal(store.data.size, 0, 'the entry it made was removed again');
    // The next load (file now stable) completes the move.
    const loaded = manager(memoryStore()).load('codex');
    assert.deepEqual(loaded, { LLM_API_KEY: SECRET, LLM_MODEL: 'saved-elsewhere' });
    assert.match(fs.readFileSync(envFile(), 'utf-8'), REF_LINE);
  });

  it('leaves a migration to a process that holds the lock', () => {
    writeEnvFile(`LLM_API_KEY=${SECRET}\n`);
    fs.writeFileSync(`${envFile()}.lock`, '');
    const store = memoryStore();
    assert.equal(manager(store).load('codex').LLM_API_KEY, SECRET);
    assert.equal(store.events.length, 0);
    assert.equal(fs.readFileSync(envFile(), 'utf-8'), `LLM_API_KEY=${SECRET}\n`);
  });

  it('a save moves plaintext secrets it did not touch as well', () => {
    writeEnvFile(`GH_TOKEN=ghp-dummy-123\nLLM_API_KEY=${SECRET}\n`);
    const store = memoryStore({ unavailable: true });
    const env = manager(store);
    env.load('codex');
    const live = memoryStore();
    manager(live).save('codex', { LLM_MODEL: 'gpt-x' });
    const text = fs.readFileSync(envFile(), 'utf-8');
    assert.ok(!text.includes(SECRET) && !text.includes('ghp-dummy-123'));
    assert.equal(live.data.size, 2);
  });
});

describe('NoStore', () => {
  it('is never available and refuses reads and writes', () => {
    const s = new NoStore();
    assert.equal(s.available(), false);
    assert.throws(() => s.set(ID, SECRET), { code: 'CREDENTIAL_STORE_UNAVAILABLE' });
    assert.throws(() => s.get(ID), { code: 'CREDENTIAL_STORE_UNAVAILABLE' });
  });
});
