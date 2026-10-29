'use strict';

// Saved agent env is a boundary: a workspace's configure_agent command, the
// launcher UI and library callers all write through EnvManager#save (the
// <type>.env files) and Config (per-agent env in daemon.yaml). These tests pin
// down what may cross it, that nothing older that slipped into a file reaches
// an agent, and that the files are private. Dummy values only; every path is
// under a temp dir and no OS credential store is used (it is mocked or off).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { EnvManager } = require('../src/env');
const { Config } = require('../src/config');
const policy = require('../src/env-policy');
const fsProtect = require('../src/fs-protect');
const { NoStore } = require('../src/credential-store');

const SECRET = 'sk-dummy-SECRET-MARKER-0123456789';
const IS_WINDOWS = process.platform === 'win32';

let tmpDir;
let warnings;

function manager(opts = {}) {
  return new EnvManager(tmpDir, { credentialStore: new NoStore({ quiet: true }), warn: (m) => warnings.push(m), ...opts });
}

function envFile(type) {
  return path.join(tmpDir, 'env', `${type}.env`);
}

function writeEnvFile(type, text) {
  fs.mkdirSync(path.join(tmpDir, 'env'), { recursive: true });
  fs.writeFileSync(envFile(type), text);
}

function refused(fn, { mustName } = {}) {
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught, 'expected the call to be refused');
  assert.equal(caught.code, 'ENV_INVALID', `unexpected error: ${caught && caught.message}`);
  assert.ok(caught instanceof policy.EnvValidationError);
  assert.ok(!caught.message.includes(SECRET), 'the error must not carry the value');
  if (mustName) assert.match(caught.message, new RegExp(mustName));
  return caught;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-envsec-'));
  warnings = [];
  fsProtect._resetForTests();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('env files: line injection', () => {
  it('refuses an LF in a value on save, writing nothing', () => {
    const env = manager();
    const e = refused(() => env.save('codex', { LLM_API_KEY: `${SECRET}\nNODE_OPTIONS=--require /tmp/evil.js` }), { mustName: 'LLM_API_KEY' });
    assert.match(e.message, /line break/);
    assert.ok(!e.message.includes('evil.js'));
    assert.equal(fs.existsSync(envFile('codex')), false);
  });

  it('refuses CRLF, a lone CR and NUL, leaving the existing file as it was', () => {
    const env = manager();
    env.save('codex', { LLM_MODEL: 'gpt-x' });
    const before = fs.readFileSync(envFile('codex'), 'utf-8');
    for (const bad of [`${SECRET}\r\nNODE_OPTIONS=x`, `${SECRET}\rLLM_BASE_URL=https://evil`, `${SECRET}\0tail`]) {
      refused(() => env.save('codex', { LLM_API_KEY: bad }), { mustName: 'LLM_API_KEY' });
    }
    assert.equal(fs.readFileSync(envFile('codex'), 'utf-8'), before);
  });

  it('checks the whole update before writing any of it', () => {
    const env = manager();
    refused(() => env.save('codex', { LLM_MODEL: 'gpt-x', LLM_API_KEY: `${SECRET}\nX=1` }));
    assert.deepEqual(env.load('codex'), {});
  });

  it('leaves out runtime-control variables an older version let into the file', () => {
    // What the old save() wrote for LLM_API_KEY="x\nNODE_OPTIONS=…".
    writeEnvFile('codex', `LLM_API_KEY=${SECRET}\nNODE_OPTIONS=--require /tmp/evil.js\nLLM_BASE_URL=https://relay.example/v1\n`);
    const env = manager();
    const registry = { getResolveRules: () => [{ from: 'LLM_API_KEY', to: 'OPENAI_API_KEY' }] };
    const loaded = env.load('codex');
    assert.equal(loaded.NODE_OPTIONS, undefined);
    assert.equal(loaded.LLM_API_KEY, SECRET);
    assert.equal(env.getEffective('codex', registry).NODE_OPTIONS, undefined);
    assert.equal(env.getEffective('codex', registry).OPENAI_API_KEY, SECRET);
    assert.equal(env.getForAgent('codex', registry, {}).NODE_OPTIONS, undefined);
    assert.ok(warnings.some((w) => w.includes('NODE_OPTIONS')));
    for (const w of warnings) {
      assert.ok(!w.includes('evil.js') && !w.includes(SECRET), `warning leaks a value: ${w}`);
    }
  });

  it('drops a line whose value carries a stray CR instead of splitting it', () => {
    writeEnvFile('codex', `LLM_API_KEY=${SECRET}\rLLM_BASE_URL=https://evil.example\nLLM_MODEL=gpt-x\n`);
    const loaded = manager().load('codex');
    assert.equal(loaded.LLM_API_KEY, undefined);
    assert.equal(loaded.LLM_BASE_URL, undefined);
    assert.equal(loaded.LLM_MODEL, 'gpt-x');
    assert.ok(warnings.some((w) => w.includes('LLM_API_KEY') && !w.includes(SECRET)));
  });

  it('still reads a file saved with CRLF line endings', () => {
    writeEnvFile('codex', 'LLM_MODEL=gpt-x\r\nLLM_BASE_URL=https://relay.example/v1\r\n');
    assert.deepEqual(manager().load('codex'), { LLM_MODEL: 'gpt-x', LLM_BASE_URL: 'https://relay.example/v1' });
  });

  it('a removed key can be resaved and a removal needs no value checks', () => {
    const env = manager();
    env.save('codex', { LLM_MODEL: 'gpt-x', LLM_BASE_URL: 'https://a' });
    env.save('codex', { LLM_MODEL: null, LLM_BASE_URL: '' });
    env.save('codex', { NODE_OPTIONS: '' }); // removing a blocked key is allowed
    assert.deepEqual(env.load('codex'), {});
  });
});

describe('env files: keys and values', () => {
  it('refuses invalid variable names', () => {
    const env = manager();
    for (const key of ['BAD KEY', '1ABC', 'A-B', 'A.B', 'K'.repeat(129), '__proto__', 'ÄKEY', '', 'A=B', `A\nB`]) {
      refused(() => env.save('codex', { [key]: SECRET }));
    }
    assert.equal(fs.existsSync(envFile('codex')), false);
  });

  it('accepts names up to 128 characters', () => {
    const env = manager();
    const key = `K${'_'.repeat(127)}`;
    env.save('codex', { [key]: 'v' });
    assert.equal(env.load('codex')[key], 'v');
  });

  it('refuses values that are not strings or are too long', () => {
    const env = manager();
    for (const value of [42, true, { a: 1 }, ['x']]) {
      const e = refused(() => env.save('codex', { LLM_MODEL: value }), { mustName: 'LLM_MODEL' });
      assert.match(e.message, /string/);
    }
    const e = refused(() => env.save('codex', { LLM_API_KEY: SECRET + 'x'.repeat(policy.MAX_VALUE_LENGTH) }));
    assert.match(e.message, /longer than/);
    env.save('codex', { LLM_MODEL: 'm'.repeat(policy.MAX_VALUE_LENGTH) });
    assert.equal(env.load('codex').LLM_MODEL.length, policy.MAX_VALUE_LENGTH);
  });

  it('refuses a value shaped like a credential reference', () => {
    refused(() => manager().save('codex', { LLM_API_KEY: `@credential:${'0'.repeat(32)}` }));
  });

  it('round-trips values with =, spaces, quotes, # and non-ASCII', () => {
    const env = manager();
    const values = {
      LLM_API_KEY: `${SECRET}==base64/like+value=`,
      LLM_BASE_URL: 'https://relay.example/v1?a=b&c=d',
      LLM_MODEL: 'a model with inner spaces',
      CUSTOM_ONE: 'quote"s and \'single\'',
      CUSTOM_TWO: 'hash # is not a comment here',
      CUSTOM_THREE: 'ค่าภาษาไทย',
      CUSTOM_FOUR: 'tab\tinside',
    };
    env.save('codex', values);
    assert.deepEqual(env.load('codex'), values);
  });

  it('trims surrounding spaces as the file format always has', () => {
    const env = manager();
    env.save('codex', { LLM_MODEL: '  gpt-x  ' });
    assert.equal(env.load('codex').LLM_MODEL, 'gpt-x');
  });

  it('never puts a value in an error message, whatever the reason', () => {
    const env = manager();
    const cases = [
      { NODE_OPTIONS: SECRET },
      { 'BAD KEY': SECRET },
      { LLM_API_KEY: `${SECRET}\n` },
      { LLM_API_KEY: `x${SECRET}`.repeat(2000) },
    ];
    for (const update of cases) refused(() => env.save('codex', update));
  });

  it('refuses an agent type that is not a plain file name', () => {
    const env = manager();
    // The old code wrote `../../<name>` to <configDir>/../<name>.env: here the
    // shared temp dir, so the name is unique to this run.
    const name = `evil-${path.basename(tmpDir)}`;
    for (const type of [`../../${name}`, `../${name}`, 'codex/../../x', '..', '.hidden', 'a\\b', 'a/b', '', 'x'.repeat(65)]) {
      const e = refused(() => env.save(type, { LLM_MODEL: 'm' }));
      assert.match(e.message, /agent type/);
      assert.deepEqual(env.load(type), {});
    }
    assert.equal(fs.existsSync(path.join(tmpDir, `${name}.env`)), false);
    assert.equal(fs.existsSync(path.join(path.dirname(tmpDir), `${name}.env`)), false);
    for (const type of ['codex', 'mini-swe-agent', 'open.claw', 'pi']) {
      assert.ok(policy.isValidAgentType(type), type);
    }
  });
});

describe('runtime-control variables', () => {
  const BLOCKED = [
    'NODE_OPTIONS', 'node_options', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
    'ELECTRON_RUN_AS_NODE', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH', 'dyld_fallback_library_path', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP',
    'PYTHONINSPECT', 'PERL5OPT', 'PERL5LIB', 'PERLLIB', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS',
    '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'PROMPT_COMMAND', 'SHELLOPTS',
    'BASHOPTS', 'IFS', 'PATH', 'Path', 'HOME', 'SHELL', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH',
    'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'npm_config_registry',
    'NPM_CONFIG_USERCONFIG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
    'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
  ];

  it('are refused on save, named in the error', () => {
    const env = manager();
    for (const key of BLOCKED) {
      const e = refused(() => env.save('codex', { [key]: SECRET }), { mustName: key });
      assert.match(e.message, /runtime-control/);
    }
    assert.equal(fs.existsSync(envFile('codex')), false);
  });

  it('do not include any variable an agent in the registry declares', () => {
    const registry = require('../registry.json');
    const entries = Array.isArray(registry) ? registry : (registry.agents || Object.values(registry));
    const names = new Set();
    for (const e of entries) {
      for (const f of e.env_config || []) names.add(f.name);
      for (const r of (e.resolve_env && e.resolve_env.rules) || []) { names.add(r.from); names.add(r.to); }
      for (const n of (e.check_ready && e.check_ready.env_vars) || []) names.add(n);
    }
    names.delete(undefined);
    assert.ok(names.size > 20);
    for (const name of names) {
      assert.equal(policy.isBlockedKey(name), false, `${name} is an agent's own variable`);
      assert.equal(policy.isValidKey(name), true, `${name} must be a valid key`);
    }
  });

  it('never reach the effective env, even through a resolve_env rule', () => {
    const env = manager();
    env.save('codex', { LLM_API_KEY: SECRET });
    const hostile = { getResolveRules: () => [{ from: 'LLM_API_KEY', to: 'NODE_OPTIONS' }, { from: 'LLM_API_KEY', to: 'OPENAI_API_KEY' }] };
    const effective = env.getEffective('codex', hostile);
    assert.equal(effective.NODE_OPTIONS, undefined);
    assert.equal(effective.OPENAI_API_KEY, SECRET);
    const forAgent = env.getForAgent('codex', hostile, {});
    assert.equal(forAgent.NODE_OPTIONS, undefined);
  });

  it('are dropped from an agent\'s own env at launch', () => {
    const env = manager();
    const agentEnv = { NODE_OPTIONS: '--require /tmp/evil.js', LD_PRELOAD: '/tmp/x.so', LLM_MODEL: 'gpt-x', 'BAD KEY': 'v' };
    const merged = env.getForAgent('codex', null, agentEnv);
    assert.equal(merged.NODE_OPTIONS, undefined);
    assert.equal(merged.LD_PRELOAD, undefined);
    assert.equal(merged['BAD KEY'], undefined);
    assert.equal(merged.LLM_MODEL, 'gpt-x');
    assert.ok(warnings.some((w) => w.includes('NODE_OPTIONS')));
    assert.ok(warnings.every((w) => !w.includes('evil.js') && !w.includes('/tmp/x.so')));
  });
});

describe('daemon.yaml: per-agent env', () => {
  function config() {
    return new Config(tmpDir);
  }

  it('addAgent refuses a runtime-control variable and writes nothing', () => {
    const cfg = config();
    refused(() => cfg.addAgent({ name: 'a', type: 'codex', env: { NODE_OPTIONS: SECRET } }), { mustName: 'NODE_OPTIONS' });
    assert.equal(fs.existsSync(cfg.configFile), false);
  });

  it('updateAgentEnv refuses line breaks, NUL, non-strings and bad names, keeping the old env', () => {
    const cfg = config();
    cfg.addAgent({ name: 'a', type: 'codex', env: { LLM_MODEL: 'gpt-x' } });
    const before = fs.readFileSync(cfg.configFile, 'utf-8');
    for (const update of [
      { LLM_API_KEY: `${SECRET}\nNODE_OPTIONS=x` },
      { LLM_API_KEY: `${SECRET}\r\n` },
      { LLM_API_KEY: `${SECRET}\0` },
      { LLM_API_KEY: 12345 },
      { 'BAD KEY': SECRET },
      { DYLD_INSERT_LIBRARIES: SECRET },
      { LLM_API_KEY: SECRET.repeat(2000) },
    ]) {
      refused(() => cfg.updateAgentEnv('a', update));
    }
    assert.equal(fs.readFileSync(cfg.configFile, 'utf-8'), before);
    assert.deepEqual(cfg.getAgent('a').env, { LLM_MODEL: 'gpt-x' });
  });

  it('round-trips valid values with =, spaces and quotes', () => {
    const cfg = config();
    cfg.addAgent({ name: 'a', type: 'codex' });
    const env = { LLM_API_KEY: `${SECRET} = "x" y`, LLM_BASE_URL: 'https://relay.example/v1?a=b' };
    cfg.updateAgentEnv('a', env);
    assert.deepEqual(cfg.getAgent('a').env, env);
  });

  it('drops what an older version or a hand edit left in the file', () => {
    const cfg = config();
    fs.writeFileSync(cfg.configFile, [
      'version: 2',
      'agents:',
      '- name: a',
      '  type: codex',
      '  env: {"NODE_OPTIONS":"--require /tmp/evil.js","LLM_MODEL":"gpt-x","LLM_API_KEY":"x\\nNODE_PATH=/tmp","PORT":5}',
      'networks: []',
      '',
    ].join('\n'));
    const agent = cfg.getAgent('a');
    assert.deepEqual(agent.env, { LLM_MODEL: 'gpt-x', PORT: '5' });
    // And a save afterwards writes the cleaned env back.
    cfg.updateAgentEnv('a', { LLM_BASE_URL: 'https://relay.example' });
    assert.ok(!fs.readFileSync(cfg.configFile, 'utf-8').includes('NODE_OPTIONS'));
    const env = new EnvManager(tmpDir, { credentialStore: new NoStore({ quiet: true }), warn: () => {} });
    assert.equal(env.getForAgent('codex', null, cfg.getAgent('a').env).NODE_OPTIONS, undefined);
  });

  it('refuses a line break in any scalar, so a field cannot inject another', () => {
    const cfg = config();
    cfg.addAgent({ name: 'a', type: 'codex' });
    const injected = 'x\n  env: {"NODE_OPTIONS":"--require /tmp/evil.js"}\n  y: z';
    let e = null;
    try { cfg.updateAgent('a', { display_name: injected }); } catch (err) { e = err; }
    assert.ok(e);
    assert.equal(e.code, 'CONFIG_INVALID');
    assert.match(e.message, /display_name/);
    assert.ok(!e.message.includes('evil.js'));
    assert.equal(cfg.getAgent('a').env, undefined);
    assert.equal(cfg.getAgent('a').display_name, undefined);
    for (const bad of ['a\rb', 'a\u2028b', 'a\0b']) {
      assert.throws(() => cfg.updateAgent('a', { display_name: bad }), { code: 'CONFIG_INVALID' });
    }
    assert.throws(() => cfg.addNetwork({ id: 'w1', slug: 'w1', token: `${SECRET}\n- name: evil` }), (err) =>
      err.code === 'CONFIG_INVALID' && !err.message.includes(SECRET));
    assert.throws(() => cfg.updateAgent('a', { 'bad\nfield': 'x' }), { code: 'CONFIG_INVALID' });
  });
});

describe('file protection', { skip: IS_WINDOWS && 'POSIX modes' }, () => {
  let oldUmask;
  beforeEach(() => { oldUmask = process.umask(0o022); });
  afterEach(() => { process.umask(oldUmask); });

  const mode = (p) => fs.statSync(p).mode & 0o777;

  it('creates the env dir 0700 and env files 0600', () => {
    const env = manager();
    env.save('codex', { LLM_API_KEY: SECRET });
    assert.equal(mode(path.join(tmpDir, 'env')), 0o700);
    assert.equal(mode(envFile('codex')), 0o600);
  });

  it('narrows an existing 0644 env file and 0755 env dir when it is read', () => {
    writeEnvFile('codex', `LLM_API_KEY=${SECRET}\n`);
    fs.chmodSync(path.join(tmpDir, 'env'), 0o755);
    fs.chmodSync(envFile('codex'), 0o644);
    assert.equal(manager().load('codex').LLM_API_KEY, SECRET);
    assert.equal(mode(path.join(tmpDir, 'env')), 0o700);
    assert.equal(mode(envFile('codex')), 0o600);
  });

  it('writes env files atomically, leaving no temp file behind', () => {
    const env = manager();
    env.save('codex', { LLM_MODEL: 'a' });
    const ino = fs.statSync(envFile('codex')).ino;
    env.save('codex', { LLM_MODEL: 'b' });
    assert.notEqual(fs.statSync(envFile('codex')).ino, ino, 'replaced by rename');
    assert.deepEqual(fs.readdirSync(path.join(tmpDir, 'env')), ['codex.env']);
  });

  it('writes daemon.yaml 0600 and narrows an existing 0644 one', () => {
    const cfg = new Config(tmpDir);
    cfg.addNetwork({ id: 'w1', slug: 'w1', token: SECRET });
    assert.equal(mode(cfg.configFile), 0o600);
    fs.chmodSync(cfg.configFile, 0o644);
    cfg.load();
    assert.equal(mode(cfg.configFile), 0o600);
    fs.chmodSync(cfg.configFile, 0o644);
    cfg.addAgent({ name: 'a', type: 'codex' });
    assert.equal(mode(cfg.configFile), 0o600);
  });

  it('rewrites daemon.yaml in place, so the daemon\'s fs.watch keeps firing', () => {
    const cfg = new Config(tmpDir);
    cfg.addAgent({ name: 'a', type: 'codex' });
    const ino = fs.statSync(cfg.configFile).ino;
    cfg.updateAgentEnv('a', { LLM_MODEL: 'gpt-x' });
    cfg.updateAgentEnv('a', { LLM_MODEL: 'gpt-y' });
    assert.equal(fs.statSync(cfg.configFile).ino, ino);
    assert.equal(cfg.getAgent('a').env.LLM_MODEL, 'gpt-y');
  });
});

describe('Windows ACL (platform and icacls mocked)', () => {
  const winEnv = { USERNAME: 'alice', USERDOMAIN: 'CORP', SystemRoot: 'C:\\Windows' };
  let calls;
  const execFileSyncMock = (cmd, args) => { calls.push({ cmd, args }); return ''; };
  const winOpts = () => ({ platform: 'win32', execFileSync: execFileSyncMock, env: winEnv, warn: () => {} });

  beforeEach(() => { calls = []; });

  function assertNoSecretInArgv() {
    for (const c of calls) {
      for (const a of [c.cmd, ...c.args]) assert.ok(!String(a).includes(SECRET), `secret in argv: ${a}`);
    }
  }

  it('restricts a file to the current user before it takes the content\'s place', () => {
    const file = path.join(tmpDir, 'codex.env');
    fsProtect.writePrivateFile(file, `LLM_API_KEY=${SECRET}\n`, winOpts());
    assert.equal(calls.length, 1);
    assert.match(calls[0].cmd, /System32[\\/]icacls\.exe$/);
    const [target, ...rest] = calls[0].args;
    assert.equal(path.dirname(target), tmpDir);
    assert.ok(path.basename(target).startsWith('.codex.env.'), 'the temp file, before the rename');
    assert.deepEqual(rest, ['/inheritance:r', '/grant:r', 'CORP\\alice:F', '/Q']);
    assert.equal(fs.readFileSync(file, 'utf-8'), `LLM_API_KEY=${SECRET}\n`);
    assertNoSecretInArgv();
  });

  it('grants directories inheritably', () => {
    const dir = path.join(tmpDir, 'env');
    fsProtect.ensurePrivateDir(dir, winOpts());
    assert.deepEqual(calls[0].args, [dir, '/inheritance:r', '/grant:r', 'CORP\\alice:(OI)(CI)F', '/Q']);
  });

  it('EnvManager and Config apply it on save, with no secret in any argv', () => {
    const env = manager({ fsOptions: winOpts() });
    env.save('codex', { LLM_API_KEY: SECRET });
    assert.ok(calls.some((c) => c.args[0] === path.join(tmpDir, 'env') && c.args.includes('CORP\\alice:(OI)(CI)F')));
    assert.ok(calls.some((c) => path.basename(c.args[0]).startsWith('.codex.env.') && c.args.includes('CORP\\alice:F')));
    const cfg = new Config(tmpDir);
    cfg._fsOptions = winOpts();
    cfg.addNetwork({ id: 'w1', slug: 'w1', token: SECRET });
    assert.ok(calls.some((c) => c.args[0] === cfg.configFile && c.args.includes('CORP\\alice:F')));
    assertNoSecretInArgv();
  });

  it('a failing icacls is reported once and does not lose the write', () => {
    const seen = [];
    const opts = { ...winOpts(), execFileSync: () => { throw new Error('icacls failed'); }, warn: (m) => seen.push(m) };
    const file = path.join(tmpDir, 'daemon.yaml');
    fsProtect.writePrivateFile(file, 'version: 2\n', { ...opts, atomic: false });
    assert.equal(fs.readFileSync(file, 'utf-8'), 'version: 2\n');
    assert.equal(seen.length, 1);
  });
});

describe('agn env', () => {
  const CLI = path.join(__dirname, '..', 'src', 'cli.js');

  function agn(args, { input } = {}) {
    try {
      const stdout = execFileSync(process.execPath, [CLI, ...args, '--config', tmpDir], {
        encoding: 'utf-8',
        input: input === undefined ? '' : input,
        env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, OPENAGENTS_SKIP_UPDATE_CHECK: '1', OPENAGENTS_CREDENTIAL_STORE: 'off' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { code: 0, stdout };
    } catch (e) {
      return { code: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
    }
  }

  it('--set-stdin reads the value from stdin, not argv', () => {
    const r = agn(['env', 'customtype', '--set-stdin', 'LLM_API_KEY'], { input: `${SECRET}\n` });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Saved LLM_API_KEY for customtype/);
    assert.equal(manager().load('customtype').LLM_API_KEY, SECRET);
  });

  it('--set refuses an injected or runtime-control variable without echoing the value', () => {
    let r = agn(['env', 'customtype', '--set', 'NODE_OPTIONS=--require /tmp/evil.js']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /NODE_OPTIONS/);
    assert.ok(!r.stdout.includes('evil.js'));
    r = agn(['env', 'customtype', '--set', `LLM_API_KEY=${SECRET}\nNODE_OPTIONS=x`]);
    assert.equal(r.code, 1);
    assert.ok(!r.stdout.includes(SECRET));
    r = agn(['env', 'customtype', '--set-stdin', 'BAD KEY'], { input: SECRET });
    assert.equal(r.code, 1);
    r = agn(['env', 'customtype', '--set-stdin', 'LLM_API_KEY'], { input: `${SECRET}\nNODE_OPTIONS=x\n` });
    assert.equal(r.code, 1);
    assert.ok(!r.stdout.includes(SECRET));
    assert.equal(fs.existsSync(envFile('customtype')), false);
  });

  it('--set-stdin with nothing on stdin refuses rather than removing the key', () => {
    assert.equal(agn(['env', 'customtype', '--set', `LLM_API_KEY=${SECRET}`]).code, 0);
    const r = agn(['env', 'customtype', '--set-stdin', 'LLM_API_KEY'], { input: '' });
    assert.equal(r.code, 1);
    assert.equal(manager().load('customtype').LLM_API_KEY, SECRET);
  });

  it('masks secrets when listing', () => {
    assert.equal(agn(['env', 'customtype', '--set', `LLM_API_KEY=${SECRET}`]).code, 0);
    assert.equal(agn(['env', 'customtype', '--set', 'LLM_MODEL=gpt-x']).code, 0);
    const r = agn(['env', 'customtype']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /LLM_API_KEY: \*\*\*/);
    assert.match(r.stdout, /LLM_MODEL: gpt-x/);
    assert.ok(!r.stdout.includes(SECRET));
  });
});
