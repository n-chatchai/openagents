'use strict';

// B3 of the pairing-first plan, client side:
//  - addNetwork is an upsert (re-registering refreshes credentials instead of
//    silently keeping a stale token after rotation/re-pair)
//  - the daemon resolves an agent's workspace credential from the device
//    pairing first, with the saved network entry as the manual fallback
//  - workspace-sent config maps are ALLOWLISTED to the type's env_config

const path = require('path');
const fs = require('fs');
const os = require('os');

// HOME must point at a sandbox BEFORE node-config computes its file path.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agn-b3-home-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { Config } = require('../src/config');
const { Daemon } = require('../src/daemon');

const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'agn-b3-cfg-'));

after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCfg, { recursive: true, force: true });
});

function writePairings(pairings) {
  const dir = path.join(tmpHome, '.openagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'node.json'),
    JSON.stringify({ node_key: 'nk-b3', pairings }),
  );
}

describe('addNetwork upsert', () => {
  it('refreshes token/endpoint/name for a known workspace', () => {
    const cfg = new Config(fs.mkdtempSync(path.join(os.tmpdir(), 'agn-up-')));
    cfg.addNetwork({ id: 'w1', slug: 'ws', name: 'Old', token: 'tok-old' });
    cfg.addNetwork({ id: 'w1', slug: 'ws', name: 'New', token: 'tok-new', endpoint: 'https://ep' });
    const nets = cfg.getNetworks();
    assert.equal(nets.length, 1);
    assert.equal(nets[0].token, 'tok-new');
    assert.equal(nets[0].name, 'New');
    assert.equal(nets[0].endpoint, 'https://ep');
  });

  it('keeps existing fields when the update omits them', () => {
    const cfg = new Config(fs.mkdtempSync(path.join(os.tmpdir(), 'agn-up2-')));
    cfg.addNetwork({ id: 'w1', slug: 'ws', name: 'Name', token: 'tok-1' });
    cfg.addNetwork({ id: 'w1', slug: 'ws' });
    assert.equal(cfg.getNetworks()[0].token, 'tok-1');
    assert.equal(cfg.getNetworks()[0].name, 'Name');
  });
});

describe('daemon network resolution (pairing first)', () => {
  beforeEach(() => writePairings([]));

  function resolve(ref, networks) {
    const fakeConfig = { getNetworks: () => networks };
    return Daemon.prototype._resolveAgentNetwork.call({ config: fakeConfig }, ref);
  }

  it('prefers the pairing token over a stale networks[] token', () => {
    writePairings([{
      node_id: 'n1', workspace_id: 'w1', workspace_slug: 'ws',
      workspace_name: 'WS', endpoint: 'https://paired', token: 'pairing-token',
    }]);
    const net = resolve('ws', [
      { id: 'w1', slug: 'ws', name: 'WS', token: 'stale-token', endpoint: 'https://old' },
    ]);
    assert.equal(net.token, 'pairing-token');
    assert.equal(net.endpoint, 'https://paired');
  });

  it('falls back to the saved network token (manual connection mode)', () => {
    const net = resolve('ws', [
      { id: 'w1', slug: 'ws', token: 'manual-token' },
    ]);
    assert.equal(net.token, 'manual-token');
  });

  it('resolves a paired workspace that has no networks[] entry at all', () => {
    writePairings([{
      node_id: 'n1', workspace_id: 'w9', workspace_slug: 'only-paired',
      workspace_name: 'Only Paired', endpoint: 'https://ep', token: 'p-tok',
    }]);
    const net = resolve('only-paired', []);
    assert.equal(net.token, 'p-tok');
    assert.equal(net.slug, 'only-paired');
  });

  it('reports a token-less network so the daemon can say "re-pair"', () => {
    const net = resolve('ws', [{ id: 'w1', slug: 'ws' }]);
    assert.equal(net.token, null);
  });

  it('returns null for an unknown reference', () => {
    assert.equal(resolve('nope', []), null);
  });
});

describe('workspace config map allowlist', () => {
  function harness(envConfig) {
    const calls = [];
    const saved = [];
    const self = Object.assign(Object.create(Daemon.prototype), {
      registry: { getEntry: () => ({ env_config: envConfig }) },
      config: { updateAgentEnv: (name, env) => { saved.push([name, env]); } },
      _runAgn: async (args) => { calls.push(args); return { code: 0 }; },
      _log: () => {},
    });
    return { self, calls, saved };
  }

  it('applies keys declared in the registry env_config, on the agent itself', async () => {
    const { self, calls, saved } = harness([{ name: 'PI_API_FORMAT' }, { name: 'PI_PROVIDER' }]);
    await Daemon.prototype._applyConfigMap.call(self, 'pi', {
      PI_API_FORMAT: 'openai-completions',
      PI_PROVIDER: 'openai',
    }, 'pi-1');
    // Never `agn env pi --set …`: that is every pi agent's, and its argv shows the value.
    assert.equal(calls.length, 0);
    assert.deepEqual(saved, [['pi-1', { PI_API_FORMAT: 'openai-completions', PI_PROVIDER: 'openai' }]]);
  });

  it('refuses keys outside env_config — no NODE_OPTIONS-class injection', async () => {
    const { self, calls, saved } = harness([{ name: 'PI_API_KEY' }]);
    await Daemon.prototype._applyConfigMap.call(self, 'pi', {
      NODE_OPTIONS: '--require /tmp/evil.js',
      PATH: '/tmp',
      PI_API_KEY: 'sk-x',
    }, 'pi-1');
    assert.equal(calls.length, 0);
    assert.deepEqual(saved, [['pi-1', { PI_API_KEY: 'sk-x' }]]);
  });

  it('saves nothing type-wide when no agent is named', async () => {
    const { self, calls, saved } = harness([{ name: 'PI_API_KEY' }]);
    await Daemon.prototype._applyConfigMap.call(self, 'pi', { PI_API_KEY: 'sk-x' });
    assert.equal(calls.length, 0);
    assert.deepEqual(saved, []);
  });

  it('applies nothing when the type has no registry entry', async () => {
    const calls = [];
    const self = Object.assign(Object.create(Daemon.prototype), {
      registry: { getEntry: () => { throw new Error('unknown'); } },
      _runAgn: async (args) => { calls.push(args); return { code: 0 }; },
      _log: () => {},
    });
    await Daemon.prototype._applyConfigMap.call(self, 'ghost', { ANY: 'x' }, 'g');
    assert.equal(calls.length, 0);
  });
});

describe('workspace model → the agent\'s own model setting', () => {
  const { Config } = require('../src/config');
  function harness(entry) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-model-'));
    const config = new Config(dir);
    const self = Object.assign(Object.create(Daemon.prototype), {
      config,
      registry: { getEntry: () => entry },
      _log: () => {},
    });
    return { self, config, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  it('also writes the model a type reads natively (CodeArts: CODEARTS_MODEL)', () => {
    const { self, config, cleanup } = harness({
      env_config: [{ name: 'CODEARTS_CLI_AK' }, { name: 'CODEARTS_CLI_SK' }, { name: 'CODEARTS_MODEL' }],
    });
    try {
      config.addAgent({ name: 'ca', type: 'codearts' });
      self._saveNodeAgentEnv('ca', 'codearts', { model: 'huaweicloud-maas/GLM-5.2' });
      assert.deepEqual(config.getAgent('ca').env, {
        LLM_MODEL: 'huaweicloud-maas/GLM-5.2',
        CODEARTS_MODEL: 'huaweicloud-maas/GLM-5.2',
      });
    } finally { cleanup(); }
  });

  it('leaves a type that maps LLM_MODEL itself to env resolution', () => {
    const { self, config, cleanup } = harness({
      env_config: [{ name: 'LLM_MODEL' }, { name: 'OPENCODE_MODEL' }],
      resolve_env: { rules: [{ from: 'LLM_MODEL', to: 'OPENCODE_MODEL' }] },
    });
    try {
      config.addAgent({ name: 'oc', type: 'opencode' });
      self._saveNodeAgentEnv('oc', 'opencode', { model: 'm' });
      assert.deepEqual(config.getAgent('oc').env, { LLM_MODEL: 'm' });
    } finally { cleanup(); }
  });
});

describe('separate accounts connected to one workspace', () => {
  const one = { node_id: 'alice-connection', workspace_id: 'same-workspace', workspace_slug: 'shared', token: 'alice-token' };
  const two = { node_id: 'bob-connection', workspace_id: 'same-workspace', workspace_slug: 'shared', token: 'bob-token' };
  beforeEach(() => writePairings([one, two]));
  it('resolves only the explicitly selected connection and refuses ambiguous legacy agents', () => {
    const daemon = { config: { getNetworks: () => [] } };
    assert.equal(Daemon.prototype._resolveAgentNetwork.call(daemon, 'shared', one.node_id).token, 'alice-token');
    assert.equal(Daemon.prototype._resolveAgentNetwork.call(daemon, 'shared', two.node_id).token, 'bob-token');
    assert.equal(Daemon.prototype._resolveAgentNetwork.call(daemon, 'shared').token, null);
    assert.equal(Daemon.prototype._resolveAgentNetwork.call(daemon, 'shared', 'revoked').token, null);
  });
  it('keeps agents out of the other connection roster and command targets', () => {
    const agent = { name: 'mine', network: 'shared', node_id: one.node_id };
    assert.equal(Daemon.prototype._agentOnNodeWorkspace(agent, one), true);
    assert.equal(Daemon.prototype._agentOnNodeWorkspace(agent, two), false);
    assert.equal(Daemon.prototype._agentOnNodeWorkspace({ name: 'legacy', network: 'shared' }, two), false);
  });
  it('preserves both pairings and only disconnects the selected one', () => {
    const cfg = require('../src/node-config');
    cfg.recordPairing('physical-device', { ...one, token: 'fresh-alice-token' });
    assert.equal(cfg.listPairings().length, 2);
    assert.throws(() => cfg.clearPairing('same-workspace'), /specific device connection/);
    cfg.clearPairing('same-workspace', one.node_id);
    assert.deepEqual(cfg.listPairings().map(p => p.node_id), [two.node_id]);
  });
});
