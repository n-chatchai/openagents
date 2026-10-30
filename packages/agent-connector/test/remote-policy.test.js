'use strict';

/**
 * What a paired workspace may do on this computer (src/policy.js), enforced
 * where its heartbeat commands run (Daemon._runNodeCommand).
 *
 * Everything runs in temp dirs: HOME is replaced before any module that reads
 * it is loaded, the launcher's config dir is its own temp dir, and every `agn`
 * child is stood in for — no real ~/.openagents, workspace, agent or install.
 * The credentials are dummies.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { Daemon } = require('../src/daemon');
const { Config } = require('../src/config');
const { EnvManager } = require('../src/env');
const { Registry } = require('../src/registry');
const policyLib = require('../src/policy');

const CLI = path.join(__dirname, '..', 'bin', 'agent-connector.js');
const NODE_A = { node_id: 'node-a', workspace_id: 'wa', workspace_slug: 'ws-a', token: 'tok-a-dummy', endpoint: 'https://a.example' };
const NODE_B = { node_id: 'node-b', workspace_id: 'wb', workspace_slug: 'ws-b', token: 'tok-b-dummy', endpoint: 'https://b.example' };
const SECRET = 'sk-SECRET-dummy-0123456789';
const isWindows = process.platform === 'win32';

// A key or endpoint exported in the shell running the tests would leak into
// what the agents' env is asserted to be.
const AMBIENT = /^(MODEL|.*_(MODEL|API_KEY|BASE_URL|AUTH_TOKEN))$/;
let scrubbed = {};
let t; // the current test's harness

function harness() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-cfg-'));
  // The person's own folders, outside the launcher's (as ~/code is outside ~/.openagents).
  const userDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-user-')));
  const config = new Config(configDir);
  const env = new EnvManager(configDir);
  const daemon = new Daemon(config, env, new Registry(configDir));
  const calls = [];
  const h = { configDir, userDir, config, env, daemon, calls, results: [], restarts: [], createStdout: '' };
  // Every `agn` child, stood in for: create/connect/remove do to config what the CLI would.
  daemon._runAgn = async (a) => {
    calls.push(a);
    if (a[0] === 'create') {
      config.addAgent({ name: a[1], type: a[3], path: a[a.indexOf('--path') + 1] });
      return { code: 0, stdout: h.createStdout, stderr: '' };
    }
    if (a[0] === 'connect') {
      config.setAgentNetwork(a[1], a[3]);
      config.updateAgent(a[1], { node_id: a[5] });
    }
    if (a[0] === 'remove') config.removeAgent(a[1]);
    return { code: 0, stdout: '', stderr: '' };
  };
  daemon._probeAgent = async () => null;
  daemon._askCliModels = () => {};
  daemon._nodeHeartbeat = async () => {};
  daemon.restartAgent = async (name) => { h.restarts.push(name); };
  for (const n of [NODE_A, NODE_B]) {
    daemon._nodeClients.set(n.node_id, { nodeCommandResult: async (_id, _tok, res) => { h.results.push(res); } });
  }
  h.run = async (node, action, args = {}) => {
    await daemon._runNodeCommand(node, { commandId: `cmd-${h.results.length}`, action, args });
    return h.results[h.results.length - 1];
  };
  h.bind = (name, type, node, extra = {}) => {
    config.addAgent({ name, type, ...extra });
    config.setAgentNetwork(name, node.workspace_slug);
    config.updateAgent(name, { node_id: node.node_id });
  };
  h.grant = (mutate) => {
    const p = policyLib.loadPolicy(configDir);
    mutate(p);
    policyLib.savePolicy(configDir, p);
  };
  h.creates = () => calls.filter((c) => c[0] === 'create');
  h.cleanup = () => {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
  };
  return h;
}

beforeEach(() => {
  scrubbed = {};
  for (const k of Object.keys(process.env)) {
    if (AMBIENT.test(k)) { scrubbed[k] = process.env[k]; delete process.env[k]; }
  }
  t = harness();
});

afterEach(() => {
  t.cleanup();
  Object.assign(process.env, scrubbed);
});

const outside = () => (isWindows ? 'C:\\Windows\\System32' : '/etc');

// ---------------------------------------------------------------------------

describe('policy defaults', () => {
  it('a computer with no policy file has the defaults; a malformed one is no looser', () => {
    assert.deepEqual(policyLib.loadPolicy(t.configDir), policyLib.defaultPolicy());
    assert.deepEqual(policyLib.defaultPolicy().remote, {
      'create-in-dir': false, 'install-runtime': false, 'remove-agent': true, 'configure-agent': true, 'list-dir': true,
    });
    fs.writeFileSync(policyLib.policyFile(t.configDir), '{ not json');
    assert.deepEqual(policyLib.loadPolicy(t.configDir), policyLib.defaultPolicy());
    fs.writeFileSync(policyLib.policyFile(t.configDir), JSON.stringify({
      remote: { 'create-in-dir': 'yes', 'install-runtime': 1, 'something-else': true }, dirs: ['relative/dir', 7], unrestricted: [''],
    }));
    const p = policyLib.loadPolicy(t.configDir);
    assert.equal(p.remote['create-in-dir'], false);
    assert.equal(p.remote['install-runtime'], false);
    assert.equal('something-else' in p.remote, false);
    assert.deepEqual(p.dirs, []);
    assert.deepEqual(p.unrestricted, []);
  });

  it('an existing pairing gets only the defaults, and no command can write the policy', async () => {
    // A device paired before the policy existed: a pairing, an agent, no policy.json.
    require('../src/node-config').recordPairing('device-key-dummy', NODE_A);
    assert.equal(require('../src/node-config').listPairings().length, 1);
    t.bind('old', 'claude', NODE_A, { path: path.join(t.userDir, 'legacy') });

    let res = await t.run(NODE_A, 'create_agent', { name: 'a1', type: 'claude', workingDir: path.join(t.userDir, 'proj') });
    assert.equal(res.ok, false);
    assert.match(res.message, /agn policy dirs add/);

    res = await t.run(NODE_A, 'create_agent', { name: 'a2', type: 'claude' });
    assert.equal(res.ok, true, res.message);
    assert.deepEqual(t.creates(), [['create', 'a2', '--type', 'claude', '--path', path.join(t.configDir, 'agents', 'a2')]]);

    res = await t.run(NODE_A, 'list_dir', { path: t.userDir });
    assert.equal(res.ok, false);

    // Configuring an agent it already had, in place, still works.
    res = await t.run(NODE_A, 'configure_agent', { name: 'old', type: 'claude', model: 'claude-sonnet-5', workingDir: path.join(t.userDir, 'legacy') });
    assert.equal(res.ok, true, res.message);

    // A command that carries a policy of its own changes nothing.
    res = await t.run(NODE_A, 'create_agent', {
      name: 'a3', type: 'claude', policy: { remote: { 'create-in-dir': true, 'install-runtime': true } }, unrestricted: true,
    });
    assert.equal(res.ok, false);
    assert.equal(t.config.getAgent('a3'), null);
    assert.equal(fs.existsSync(policyLib.policyFile(t.configDir)), false);
    assert.deepEqual(policyLib.loadPolicy(t.configDir), policyLib.defaultPolicy());
  });
});

// ---------------------------------------------------------------------------

describe('remote create: folders', () => {
  it('refuses a system folder and the home folder without dirs and create-in-dir', async () => {
    for (const dir of [outside(), os.homedir(), t.userDir]) {
      const res = await t.run(NODE_A, 'create_agent', { name: 'x', type: 'claude', workingDir: dir });
      assert.equal(res.ok, false, dir);
      assert.match(res.message, /does not let the workspace create agents/);
      assert.match(res.message, /agn policy dirs add <folder> && agn policy allow create-in-dir/);
    }
    assert.deepEqual(t.creates(), []);
    assert.equal(t.config.getAgent('x'), null);
  });

  it('needs both: a listed folder and create-in-dir', async () => {
    const allowed = path.join(t.userDir, 'code');
    fs.mkdirSync(allowed);
    t.grant((p) => { p.dirs = [allowed]; });
    let res = await t.run(NODE_A, 'create_agent', { name: 'x', type: 'claude', workingDir: path.join(allowed, 'x') });
    assert.equal(res.ok, false);
    assert.match(res.message, /allow create-in-dir/);

    t.grant((p) => { p.remote['create-in-dir'] = true; });
    res = await t.run(NODE_A, 'create_agent', { name: 'x', type: 'claude', workingDir: outside() });
    assert.equal(res.ok, false, 'a folder outside the listed ones stays refused');
    res = await t.run(NODE_A, 'create_agent', { name: 'x', type: 'claude', workingDir: path.join(allowed, 'x') });
    assert.equal(res.ok, true, res.message);
    assert.equal(t.config.getAgent('x').path, path.join(allowed, 'x'));
  });

  it('a symlink inside an allowed folder cannot lead out of it', { skip: isWindows && 'symlinks need privileges' }, async () => {
    const allowed = path.join(t.userDir, 'code');
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-elsewhere-'));
    try {
      fs.mkdirSync(allowed);
      fs.symlinkSync(elsewhere, path.join(allowed, 'escape'), 'dir');
      t.grant((p) => { p.dirs = [allowed]; p.remote['create-in-dir'] = true; });
      for (const dir of [path.join(allowed, 'escape'), path.join(allowed, 'escape', 'deeper')]) {
        const res = await t.run(NODE_A, 'create_agent', { name: 'x', type: 'claude', workingDir: dir });
        assert.equal(res.ok, false, dir);
      }
      const listed = await t.run(NODE_A, 'list_dir', { path: path.join(allowed, 'escape') });
      assert.equal(listed.ok, false);
      assert.deepEqual(t.creates(), []);
      assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was made out there');
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('`..` cannot climb out of an allowed folder', async () => {
    const allowed = path.join(t.userDir, 'code');
    fs.mkdirSync(allowed);
    t.grant((p) => { p.dirs = [allowed]; p.remote['create-in-dir'] = true; });
    const climb = `${allowed}${path.sep}..${path.sep}..${path.sep}outside`;
    const res = await t.run(NODE_A, 'create_agent', { name: 'x', type: 'claude', workingDir: climb });
    assert.equal(res.ok, false);
    const listed = await t.run(NODE_A, 'list_dir', { path: `${allowed}${path.sep}..` });
    assert.equal(listed.ok, false);
    const relative = await t.run(NODE_A, 'create_agent', { name: 'x', type: 'claude', workingDir: 'code/x' });
    assert.equal(relative.ok, false);
    assert.match(relative.message, /full folder path/);
  });

  it('refuses another agent\'s managed folder and the launcher\'s own folder', async () => {
    t.grant((p) => { p.dirs = [path.dirname(t.configDir)]; p.remote['create-in-dir'] = true; });
    for (const dir of [
      path.join(t.configDir, 'agents', 'someone-else'),
      path.join(t.configDir, 'env'),
      t.configDir,
    ]) {
      const res = await t.run(NODE_A, 'create_agent', { name: 'x', type: 'claude', workingDir: dir });
      assert.equal(res.ok, false, dir);
    }
    // Its own managed folder, or the managed root (= its own folder), is fine.
    const own = await t.run(NODE_A, 'create_agent', { name: 'x', type: 'claude', workingDir: path.join(t.configDir, 'agents') });
    assert.equal(own.ok, true, own.message);
    assert.equal(t.config.getAgent('x').path, path.join(t.configDir, 'agents', 'x'));
  });

  it('refuses a name that would be a flag or a path before anything runs', async () => {
    for (const name of ['--allow-unverified', '-x', '../escape', 'a/b', 'a\\b', '.hidden', '..', '']) {
      const res = await t.run(NODE_A, 'create_agent', { name, type: 'claude' });
      assert.equal(res.ok, false, name);
    }
    assert.deepEqual(t.calls, []);
  });

  it('refuses an agent type that is a path or a flag before anything runs', async () => {
    for (const type of ['../../escape', '--install', 'a/b', 'a\\b', '.x', '']) {
      const res = await t.run(NODE_A, 'create_agent', { name: 'x', type });
      assert.equal(res.ok, false, type);
    }
    assert.deepEqual(t.calls, []);
    // An agent saved with such a type (by an older launcher) is not recreated under it.
    t.bind('odd', 'claude', NODE_A, { path: path.join(t.userDir, 'old') });
    t.config.updateAgent('odd', { type: '../../escape' });
    t.grant((p) => { p.dirs = [t.userDir]; p.remote['create-in-dir'] = true; });
    const res = await t.run(NODE_A, 'configure_agent', { name: 'odd', workingDir: path.join(t.userDir, 'new') });
    assert.equal(res.ok, false);
    assert.deepEqual(t.calls, []);
  });

  it('refuses text the config could not hold as sent, before anything is written', async () => {
    t.bind('c', 'codex', NODE_A, { env: { LLM_API_KEY: 'sk-old-dummy' } });
    for (const extra of [
      { apiKey: 'sk-new\nOPENAGENTS_AUTH_MODE: cli_login' },
      { model: 'm\r' },
      { baseUrl: { href: 'https://x.example' } },
      { config: { OPENAI_API_KEY: 'a\u0000b' } },
    ]) {
      const res = await t.run(NODE_A, 'configure_agent', { name: 'c', type: 'codex', ...extra });
      assert.equal(res.ok, false, JSON.stringify(extra));
      assert.match(res.message, /cannot store/);
    }
    assert.deepEqual(t.config.getAgent('c').env, { LLM_API_KEY: 'sk-old-dummy' });
    const created = await t.run(NODE_A, 'create_agent', { name: 'n', type: 'codex', model: 'line\nbreak' });
    assert.equal(created.ok, false);
    assert.deepEqual(t.calls, []);
  });

  it('a value the config store refuses is reported by field, never quoted', async () => {
    t.bind('c', 'codex', NODE_A);
    const logged = [];
    t.daemon._log = (m) => { logged.push(String(m)); };
    t.config.updateAgentEnv = () => {
      const e = new Error(`invalid value for LLM_API_KEY: ${SECRET}`);
      e.code = 'CONFIG_INVALID';
      e.field = 'LLM_API_KEY';
      throw e;
    };
    const res = await t.run(NODE_A, 'configure_agent', { name: 'c', type: 'codex', apiKey: SECRET });
    assert.equal(res.ok, false);
    assert.match(res.message, /could not save what the workspace sent for LLM_API_KEY/);
    assert.ok(!res.message.includes(SECRET));
    for (const line of logged) assert.ok(!line.includes(SECRET), line);
    assert.deepEqual(t.restarts, []);
  });

  it('a name kept for an unrestricted agent cannot be claimed remotely', async () => {
    t.grant((p) => { p.unrestricted = ['trusted']; });
    const res = await t.run(NODE_A, 'create_agent', { name: 'trusted', type: 'claude' });
    assert.equal(res.ok, false);
    assert.match(res.message, /agn policy unrestricted remove trusted/);
    assert.deepEqual(t.calls, []);
  });

  it('refuses fields that widen what an agent may do, and creates nothing', async () => {
    for (const extra of [
      { yolo: true },
      { dangerouslySkipPermissions: true },
      { permissionMode: 'bypassPermissions' },
      { allowUnverified: true },
      { config: { DSH_PERMISSION_MODE: 'danger-full-access' } },
      { config: { NODE_OPTIONS: '--require /tmp/x.js' } },
    ]) {
      const res = await t.run(NODE_A, 'create_agent', { name: 'x', type: 'deepseek', ...extra });
      assert.equal(res.ok, false, JSON.stringify(extra));
      assert.match(res.message, /changes what an agent may do/);
    }
    assert.deepEqual(t.calls, []);
    // Fields it does not read are ignored, and said so.
    const res = await t.run(NODE_A, 'create_agent', { name: 'x', type: 'deepseek', colour: 'blue' });
    assert.equal(res.ok, true, res.message);
    assert.deepEqual(res.data.ignored, ['colour']);
    assert.match(res.message, /Not used: colour/);
  });
});

// ---------------------------------------------------------------------------

describe('remote list_dir', () => {
  it('refuses folders outside the allowed roots', async () => {
    for (const p of [path.parse(t.userDir).root, os.homedir(), t.configDir, path.join(t.configDir, 'env'), t.userDir]) {
      const res = await t.run(NODE_A, 'list_dir', { path: p });
      assert.equal(res.ok, false, p);
      assert.equal(res.data, null);
    }
  });

  it('in the managed root a workspace sees only its own agents\' folders', async () => {
    t.bind('mine', 'claude', NODE_A);
    t.bind('theirs', 'claude', NODE_B);
    for (const n of ['mine', 'theirs']) fs.mkdirSync(path.join(t.configDir, 'agents', n, 'src'), { recursive: true });
    let res = await t.run(NODE_A, 'list_dir', {});
    assert.equal(res.ok, true, res.message);
    assert.deepEqual(res.data.dirs, ['mine']);
    assert.equal(res.data.parent, null, 'nothing above the managed root is offered');
    res = await t.run(NODE_A, 'list_dir', { path: path.join(t.configDir, 'agents', 'theirs') });
    assert.equal(res.ok, false);
    res = await t.run(NODE_A, 'list_dir', { path: path.join(t.configDir, 'agents', 'mine') });
    assert.equal(res.ok, true, res.message);
    assert.deepEqual(res.data.dirs, ['src']);
  });

  it('a listed folder can be browsed; list-dir denied refuses everything', async () => {
    const allowed = path.join(t.userDir, 'code');
    fs.mkdirSync(path.join(allowed, 'app'), { recursive: true });
    t.grant((p) => { p.dirs = [allowed]; });
    let res = await t.run(NODE_A, 'list_dir', { path: allowed });
    assert.equal(res.ok, true, res.message);
    assert.deepEqual(res.data.dirs, ['app']);
    res = await t.run(NODE_A, 'list_dir', { path: path.join(allowed, 'app') });
    assert.equal(res.data.parent, allowed);
    t.grant((p) => { p.remote['list-dir'] = false; });
    res = await t.run(NODE_A, 'list_dir', { path: allowed });
    assert.equal(res.ok, false);
    assert.match(res.message, /agn policy allow list-dir/);
  });

  it('the heartbeat reports only the allowed roots, never the home folder', () => {
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    const managed = path.join(t.configDir, 'agents');
    let reported = t.daemon._buildFs();
    assert.deepEqual(reported, { home: managed, dirs: [], roots: [managed] });
    t.grant((p) => { p.dirs = [t.userDir, path.join(t.userDir, 'gone')]; });
    reported = t.daemon._buildFs();
    assert.deepEqual(reported.roots, [managed, t.userDir], 'a listed folder that no longer exists is left out');
    assert.ok(!JSON.stringify(reported).includes('Documents'));
  });
});

// ---------------------------------------------------------------------------

describe('remote configure and remove', () => {
  it('configure cannot set unrestricted or a bypass mode, and changes nothing when it tries', async () => {
    const own = { DEEPSEEK_API_KEY: 'sk-own-dummy', DSH_PERMISSION_MODE: 'workspace-write' };
    t.bind('ds', 'deepseek', NODE_A, { env: own });
    t.bind('ow', 'openworker', NODE_A, { env: { OPENWORKER_MODE: 'plan' } });
    for (const [name, type, extra] of [
      ['ds', 'deepseek', { unrestricted: true }],
      ['ds', 'deepseek', { bypassApprovals: true, model: 'x' }],
      ['ds', 'deepseek', { config: { DSH_PERMISSION_MODE: 'danger-full-access' } }],
      ['ow', 'openworker', { config: { OPENWORKER_MODE: 'bypass-approvals' } }],
      ['ow', 'openworker', { config: { OPENWORKER_ALLOW_TOOL_INSTALL: '1' } }],
      ['ow', 'openworker', { config: { OPENWORKER_STATE_DIR: '/tmp/other-store' } }],
    ]) {
      const res = await t.run(NODE_A, 'configure_agent', { name, type, ...extra });
      assert.equal(res.ok, false, JSON.stringify(extra));
      assert.match(res.message, /changes what an agent may do/);
    }
    assert.deepEqual(t.config.getAgent('ds').env, own);
    assert.deepEqual(t.config.getAgent('ow').env, { OPENWORKER_MODE: 'plan' });
    assert.deepEqual(t.restarts, []);
    // Narrowing is the workspace's to ask for.
    const res = await t.run(NODE_A, 'configure_agent', { name: 'ds', type: 'deepseek', config: { DSH_PERMISSION_MODE: 'read-only' } });
    assert.equal(res.ok, true, res.message);
    assert.equal(t.config.getAgent('ds').env.DSH_PERMISSION_MODE, 'read-only');
  });

  it('configure cannot turn an agent into another runtime', async () => {
    t.bind('c', 'claude', NODE_A);
    const res = await t.run(NODE_A, 'configure_agent', { name: 'c', type: 'hermes', apiKey: SECRET });
    assert.equal(res.ok, false);
    assert.equal(t.config.getAgent('c').type, 'claude');
    assert.equal(t.config.getAgent('c').env, undefined);
  });

  it('a folder change gets create\'s folder rules', async () => {
    t.bind('c', 'claude', NODE_A, { path: path.join(t.userDir, 'old') });
    let res = await t.run(NODE_A, 'configure_agent', { name: 'c', type: 'claude', workingDir: outside() });
    assert.equal(res.ok, false);
    assert.equal(t.config.getAgent('c').path, path.join(t.userDir, 'old'));
    assert.deepEqual(t.calls, []);
    t.grant((p) => { p.dirs = [t.userDir]; p.remote['create-in-dir'] = true; });
    res = await t.run(NODE_A, 'configure_agent', { name: 'c', type: 'claude', workingDir: path.join(t.userDir, 'new') });
    assert.equal(res.ok, true, res.message);
    assert.equal(t.config.getAgent('c').path, path.join(t.userDir, 'new'));
    // No install on the recreate either: install-runtime is off.
    assert.ok(t.creates().every((c) => !c.includes('--install')));
  });

  it('configure and remove can each be turned off on this computer', async () => {
    t.bind('c', 'claude', NODE_A);
    t.grant((p) => { p.remote['configure-agent'] = false; p.remote['remove-agent'] = false; });
    let res = await t.run(NODE_A, 'configure_agent', { name: 'c', type: 'claude', model: 'm' });
    assert.equal(res.ok, false);
    assert.match(res.message, /agn policy allow configure-agent/);
    res = await t.run(NODE_A, 'remove_agent', { name: 'c' });
    assert.equal(res.ok, false);
    assert.match(res.message, /agn policy allow remove-agent/);
    assert.ok(t.config.getAgent('c'));
    assert.deepEqual(t.calls, []);
  });

  it('remove takes the agent off this computer but never deletes its folder', async () => {
    const proj = path.join(t.userDir, 'proj');
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, 'notes.md'), 'mine');
    t.bind('c', 'claude', NODE_A, { path: proj });
    const res = await t.run(NODE_A, 'remove_agent', { name: 'c' });
    assert.equal(res.ok, true, res.message);
    assert.deepEqual(t.calls, [['remove', 'c']]);
    assert.equal(fs.readFileSync(path.join(proj, 'notes.md'), 'utf8'), 'mine');
  });

  it('a workspace label that is not one line of text is not written into the config', async () => {
    require('../src/node-config').recordPairing('device-key-dummy', NODE_A);
    t.bind('c', 'claude', NODE_A);
    t.bind('d', 'claude', NODE_A);
    t.daemon._nodeClients.set(NODE_A.node_id, {
      getAgents: async () => [
        { agentName: 'c', displayName: 'Ok\nnetworks: []' },
        { agentName: 'd', displayName: 'Reviewer' },
      ],
    });
    await t.daemon._syncDisplayNames();
    assert.equal(t.config.getAgent('c').display_name, undefined);
    assert.equal(t.config.getAgent('d').display_name, 'Reviewer');
  });

  it('start and stop of its own agent still work; another workspace\'s agent is refused', async () => {
    t.bind('mine', 'claude', NODE_A);
    t.bind('theirs', 'claude', NODE_B);
    const did = [];
    t.daemon.stopAgent = async (name) => { did.push(['stop', name]); };
    t.daemon._startAgentIfIdle = async (name) => { did.push(['start', name]); };
    assert.equal((await t.run(NODE_A, 'stop_agent', { name: 'mine' })).ok, true);
    assert.equal((await t.run(NODE_A, 'start_agent', { name: 'mine' })).ok, true);
    const foreign = await t.run(NODE_A, 'stop_agent', { name: 'theirs' });
    assert.equal(foreign.ok, false);
    assert.match(foreign.message, /not managed by this workspace/);
    assert.deepEqual(did, [['stop', 'mine'], ['start', 'mine']]);
  });
});

// ---------------------------------------------------------------------------

describe('remote installs', () => {
  it('install-runtime off: create installs nothing and says what to run on the computer', async () => {
    t.createStdout = "Created local agent: x (type: claude)\nRuntime 'claude' is not installed. Run: agn install claude\n";
    const res = await t.run(NODE_A, 'create_agent', { name: 'x', type: 'claude' });
    assert.equal(res.ok, true, res.message);
    assert.ok(t.creates().every((c) => !c.includes('--install')));
    assert.match(res.message, /claude is not installed on this computer/);
    assert.match(res.message, /agn policy allow install-runtime/);
    assert.equal(t.daemon._probes.x.code, 'install_not_allowed');
  });

  it('install-runtime on: a verified route installs; an unverified one never does', async () => {
    t.grant((p) => { p.remote['install-runtime'] = true; });
    let res = await t.run(NODE_A, 'create_agent', { name: 'cc', type: 'claude' });
    assert.equal(res.ok, true, res.message);
    assert.deepEqual(t.creates()[0], ['create', 'cc', '--type', 'claude', '--install', '--path', path.join(t.configDir, 'agents', 'cc')]);

    t.createStdout = "Runtime 'cursor' is not installed. Its installer cannot be verified.\n";
    res = await t.run(NODE_A, 'create_agent', { name: 'cu', type: 'cursor' });
    assert.equal(res.ok, true, res.message);
    assert.ok(!t.creates()[1].includes('--install'));
    assert.match(res.message, /cannot be verified/);
    assert.match(res.message, /agn install cursor --allow-unverified/);
  });

  it('a type only a server lists is never installed remotely, whatever pin it carries', () => {
    const policy = { ...policyLib.defaultPolicy(), remote: { ...policyLib.REMOTE_OPS, 'install-runtime': true } };
    const served = {
      name: 'served-only',
      install: { macos: 'npm install -g served-only', linux: 'npm install -g served-only', windows: 'npm install -g served-only',
        npm_package: 'served-only', npm_version: '1.0.0', npm_integrity: `sha512-${'A'.repeat(86)}==` },
    };
    assert.equal(t.daemon._remoteInstall(policy, 'served-only', served).flag, false);
    // A shipped type whose entry was swapped for a script is not verified either.
    const claude = t.daemon._registryEntry('claude');
    const swapped = { ...claude, install: { ...claude.install, macos: 'curl https://x.example | sh', linux: 'curl https://x.example | sh', windows: 'irm https://x.example | iex' } };
    assert.equal(t.daemon._remoteInstall(policy, 'claude', swapped).flag, false);
  });

  it('env_config keys a served catalog adds (NODE_OPTIONS) are never applied', async () => {
    t.bind('c', 'claude', NODE_A);
    const real = t.daemon.registry.getEntry.bind(t.daemon.registry);
    t.daemon.registry.getEntry = (type) => {
      const e = real(type);
      return e && { ...e, env_config: [...(e.env_config || []), { name: 'NODE_OPTIONS' }, { name: 'EXTRA_SETTING' }] };
    };
    await t.daemon._applyConfigMap('claude', { NODE_OPTIONS: '--require /tmp/x.js', EXTRA_SETTING: '1' }, 'c');
    assert.equal(t.config.getAgent('c').env, undefined);
  });
});

// ---------------------------------------------------------------------------

describe('cross-workspace isolation', () => {
  const NO_CREDS = ['LLM_API_KEY', 'LLM_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
  for (const type of ['hermes', 'codex', 'openclaw', 'opencode']) {
    it(`configuring a ${type} agent from workspace A leaves workspace B's ${type} agent as it was`, async () => {
      for (const k of NO_CREDS) delete process.env[k];
      t.env.save(type, { LLM_MODEL: 'type-model' });
      t.bind('a', type, NODE_A, { env: { LLM_API_KEY: 'sk-a-dummy', LLM_MODEL: 'a-model' } });
      t.bind('b', type, NODE_B, { env: { LLM_API_KEY: 'sk-b-dummy', LLM_BASE_URL: 'https://b.example/v1', LLM_MODEL: 'b-model' } });
      t.bind('local', type, NODE_A);
      t.config.setAgentNetwork('local', null); // a local-only agent of the same type
      const before = {
        b: t.daemon._buildAgentEnv(t.config.getAgent('b')),
        local: t.daemon._buildAgentEnv(t.config.getAgent('local')),
        typeEnv: t.env.load(type),
      };
      const res = await t.run(NODE_A, 'configure_agent', {
        name: 'a', type, apiKey: SECRET, baseUrl: 'https://relay-a.example/v1', model: 'relay-model',
        config: { LLM_API_KEY: SECRET, LLM_BASE_URL: 'https://relay-a.example/v1', LLM_MODEL: 'relay-model' },
      });
      assert.equal(res.ok, true, res.message);
      assert.deepEqual(t.daemon._buildAgentEnv(t.config.getAgent('b')), before.b);
      assert.deepEqual(t.daemon._buildAgentEnv(t.config.getAgent('local')), before.local);
      assert.deepEqual(t.env.load(type), before.typeEnv);
      assert.equal(t.config.getAgent('a').env.LLM_API_KEY, SECRET);
    });
  }

  it('a Hermes sign-in switch touches the computer-wide Hermes config only when no other workspace has a Hermes agent', async () => {
    const hermes = require('../src/adapters/hermes');
    const realRestore = hermes.restoreNativeAuth;
    let restored = 0;
    hermes.restoreNativeAuth = () => { restored++; return { skipped: true }; };
    try {
      t.bind('ha', 'hermes', NODE_A, { env: { LLM_API_KEY: 'sk-a-dummy' } });
      t.bind('hb', 'hermes', NODE_B, { env: { LLM_API_KEY: 'sk-b-dummy' } });
      let res = await t.run(NODE_A, 'configure_agent', { name: 'ha', type: 'hermes', authMode: 'cli_login' });
      assert.equal(res.ok, true, res.message);
      assert.equal(restored, 0, 'workspace B\'s Hermes agent still runs on that config');
      t.config.removeAgent('hb');
      res = await t.run(NODE_A, 'configure_agent', { name: 'ha', type: 'hermes', authMode: 'cli_login' });
      assert.equal(res.ok, true, res.message);
      assert.equal(restored, 1);
    } finally {
      hermes.restoreNativeAuth = realRestore;
    }
  });
});

// ---------------------------------------------------------------------------

describe('secrets and child processes', () => {
  it('no secret a workspace sends reaches any child process\'s argv', async () => {
    const cp = require('child_process');
    const names = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'];
    const real = Object.fromEntries(names.map((n) => [n, cp[n]]));
    const seen = [];
    const logged = [];
    t.daemon._log = (msg) => { logged.push(String(msg)); };
    for (const n of names) {
      cp[n] = function patched(...args) {
        seen.push(JSON.stringify(args.filter((a) => typeof a === 'string' || Array.isArray(a))));
        return real[n].apply(this, args);
      };
    }
    try {
      t.bind('h', 'hermes', NODE_A, { env: { LLM_API_KEY: 'sk-old-dummy' } });
      await t.run(NODE_A, 'configure_agent', { name: 'h', type: 'hermes', apiKey: SECRET, baseUrl: 'https://relay.example/v1', config: { LLM_API_KEY: SECRET } });
      await t.run(NODE_A, 'create_agent', { name: 'h2', type: 'hermes', apiKey: SECRET, config: { LLM_API_KEY: SECRET, LLM_BASE_URL: 'https://relay.example/v1' } });
      await t.run(NODE_A, 'create_agent', { name: 'ca', type: 'codearts', config: { CODEARTS_CLI_AK: SECRET, CODEARTS_CLI_SK: SECRET } });
      await t.run(NODE_A, 'create_agent', { name: 'cx', type: 'codex', apiKey: SECRET, model: 'm' });
    } finally {
      for (const n of names) cp[n] = real[n];
    }
    const argvs = [...t.calls.map((c) => JSON.stringify(c)), ...seen];
    assert.ok(t.calls.length > 0);
    for (const a of argvs) assert.ok(!a.includes(SECRET), `secret in argv: ${a}`);
    assert.ok(!t.calls.some((c) => c[0] === 'env'), 'no `agn env … KEY=VALUE` child');
    // …and it is where it belongs: on the agents' own env.
    assert.equal(t.config.getAgent('h').env.LLM_API_KEY, SECRET);
    assert.equal(t.config.getAgent('ca').env.CODEARTS_CLI_SK, SECRET);
    // Nor the daemon's log, refusals included.
    await t.run(NODE_A, 'configure_agent', { name: 'h', type: 'hermes', config: { LLM_API_KEY: SECRET, NODE_OPTIONS: SECRET } });
    assert.ok(logged.length > 0);
    for (const line of logged) assert.ok(!line.includes(SECRET), `secret in log: ${line}`);
  });

  it('an `agn` child the daemon runs cannot grant itself policy', async () => {
    // The real _runAgn: a real CLI child, on the temp HOME's config dir.
    const daemon = new Daemon(new Config(path.join(HOME, '.openagents')), new EnvManager(t.configDir), new Registry(t.configDir));
    const r = await daemon._runAgn(['policy', 'allow', 'install-runtime']);
    assert.notEqual(r.code, 0);
    assert.match(r.stdout, /Refused: allowing install-runtime was asked for by the OpenAgents daemon/);
    assert.equal(policyLib.loadPolicy(path.join(HOME, '.openagents')).remote['install-runtime'], false);
  });
});

// ---------------------------------------------------------------------------

describe('agn policy', () => {
  const local = { interactive: true, unattended: false };
  const exists = (names) => ({ ...local, agentExists: (n) => names.includes(n) });

  it('allow and deny an operation; show lists it', () => {
    let r = policyLib.runPolicyCommand(t.configDir, ['allow', 'create-in-dir'], local);
    assert.equal(r.code, 0);
    assert.equal(policyLib.loadPolicy(t.configDir).remote['create-in-dir'], true);
    if (!isWindows) assert.equal(fs.statSync(policyLib.policyFile(t.configDir)).mode & 0o777, 0o600);
    r = policyLib.runPolicyCommand(t.configDir, ['show'], local);
    assert.ok(r.lines.some((l) => /create-in-dir\s+allowed/.test(l)));
    assert.ok(r.lines.some((l) => /install-runtime\s+denied/.test(l)));
    r = policyLib.runPolicyCommand(t.configDir, ['deny', 'create-in-dir'], local);
    assert.equal(policyLib.loadPolicy(t.configDir).remote['create-in-dir'], false);
    r = policyLib.runPolicyCommand(t.configDir, ['allow', 'everything'], local);
    assert.equal(r.code, 1);
  });

  it('dirs add stores the real path; the launcher\'s own folder cannot be added', { skip: isWindows && 'symlinks need privileges' }, () => {
    const real = path.join(t.userDir, 'code');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(t.userDir, 'link'), 'dir');
    let r = policyLib.runPolicyCommand(t.configDir, ['dirs', 'add', path.join(t.userDir, 'link')], local);
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.deepEqual(policyLib.loadPolicy(t.configDir).dirs, [real]);
    r = policyLib.runPolicyCommand(t.configDir, ['dirs', 'add', path.join(t.userDir, 'missing')], local);
    assert.equal(r.code, 1);
    fs.mkdirSync(path.join(t.configDir, 'agents'), { recursive: true });
    r = policyLib.runPolicyCommand(t.configDir, ['dirs', 'add', path.join(t.configDir, 'agents')], local);
    assert.equal(r.code, 1);
    r = policyLib.runPolicyCommand(t.configDir, ['dirs', 'remove', path.join(t.userDir, 'link')], local);
    assert.equal(r.code, 0);
    assert.deepEqual(policyLib.loadPolicy(t.configDir).dirs, []);
  });

  it('unrestricted add names an existing agent and warns what it means', () => {
    let r = policyLib.runPolicyCommand(t.configDir, ['unrestricted', 'add', 'ghost'], exists(['real']));
    assert.equal(r.code, 1, 'a name nobody has yet could be claimed by a remote create');
    r = policyLib.runPolicyCommand(t.configDir, ['unrestricted', 'add', 'real'], exists(['real']));
    assert.equal(r.code, 0);
    assert.match(r.lines.join('\n'), /WARNING: 'real' will run without its runtime's approval prompts and sandbox/);
    assert.deepEqual(policyLib.loadPolicy(t.configDir).unrestricted, ['real']);
    r = policyLib.runPolicyCommand(t.configDir, ['unrestricted', 'remove', 'real'], local);
    assert.deepEqual(policyLib.loadPolicy(t.configDir).unrestricted, []);
  });

  it('granting needs a person at the computer; taking away works from anywhere', () => {
    for (const ctx of [{ interactive: false }, { interactive: true, unattended: true }]) {
      for (const argv of [['allow', 'install-runtime'], ['dirs', 'add', t.userDir], ['unrestricted', 'add', 'real']]) {
        const r = policyLib.runPolicyCommand(t.configDir, argv, { ...ctx, agentExists: () => true });
        assert.equal(r.code, 1, argv.join(' '));
        assert.match(r.lines.join('\n'), /^Refused/m);
      }
    }
    assert.equal(fs.existsSync(policyLib.policyFile(t.configDir)), false);
    const r = policyLib.runPolicyCommand(t.configDir, ['deny', 'list-dir'], { interactive: false });
    assert.equal(r.code, 0);
    assert.equal(policyLib.loadPolicy(t.configDir).remote['list-dir'], false);
  });

  it('the CLI: `agn policy` refuses a grant without a terminal, denies and shows', () => {
    const env = { ...process.env, HOME, USERPROFILE: HOME, OPENAGENTS_SKIP_UPDATE_CHECK: '1' };
    delete env.OPENAGENTS_UNATTENDED;
    const run = (...args) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [CLI, 'policy', ...args, '--config', t.configDir], { env, encoding: 'utf8', timeout: 20000 }) };
      } catch (e) {
        return { code: e.status, out: String(e.stdout || '') };
      }
    };
    let r = run('allow', 'install-runtime');
    assert.equal(r.code, 1);
    assert.match(r.out, /needs a person at this computer/);
    r = run('deny', 'remove-agent');
    assert.equal(r.code, 0, r.out);
    r = run('show', '--json');
    assert.equal(r.code, 0, r.out);
    const shown = JSON.parse(r.out);
    assert.equal(shown.remote['remove-agent'], false);
    assert.equal(shown.remote['install-runtime'], false);
  });
});
