'use strict';

/**
 * Agents run inside their runtime's own approval and sandbox controls.
 *
 * `execute` means "act within those controls", not "turn them off". An agent
 * runs without them only when this computer's policy.json lists it
 * (`agn policy unrestricted add <name>`), only that agent, and nothing a
 * workspace sends — set_mode, create/configure arguments, the agent env it can
 * write — can turn that on. Runtimes that can only run unattended with their
 * approvals off refuse the turn instead, naming the command that allows it.
 *
 * Every command here is BUILT, never run: no real claude/codex/… is spawned.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { savePolicy, defaultPolicy } = require('../src/policy');
const { createAdapter } = require('../src/adapters');
const ClaudeAdapter = require('../src/adapters/claude');
const CodexAdapter = require('../src/adapters/codex');
const CursorAdapter = require('../src/adapters/cursor');
const GeminiAdapter = require('../src/adapters/gemini');
const OpenCodeAdapter = require('../src/adapters/opencode');
const { buildAgyArgv } = require('../src/adapters/antigravity-stream');
const { buildClineArgs } = require('../src/adapters/cline-stream');

const ENDPOINT = 'https://workspace-endpoint.openagents.org';
const BYPASS_FLAGS = [
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo', '-y', '--force', '--auto', '--allow-tool=shell',
  'bypassPermissions',
];

let tmp;
let configDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-approval-'));
  configDir = path.join(tmp, '.openagents');
  fs.mkdirSync(configDir, { recursive: true });
  savePolicy(configDir, defaultPolicy());
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function allow(...names) {
  savePolicy(configDir, { ...defaultPolicy(), unrestricted: names });
}

function make(type, agentName, extra = {}) {
  const workingDir = path.join(configDir, 'agents', agentName);
  fs.mkdirSync(workingDir, { recursive: true });
  const a = createAdapter(type, {
    workspaceId: 'ws',
    channelName: 'general',
    token: 'tok',
    agentName,
    endpoint: ENDPOINT,
    agentType: type,
    configDir,
    workingDir,
    agentEnv: { PATH: process.env.PATH },
    logSink: () => {},
    ...extra,
  });
  a._sent = { error: [], status: [], response: [], thinking: [] };
  a.sendError = async (_c, t) => { a._sent.error.push(t); };
  a.sendStatus = async (_c, t) => { a._sent.status.push(t); };
  a.sendResponse = async (_c, t) => { a._sent.response.push(t); };
  a.sendThinking = async (_c, t) => { a._sent.thinking.push(t); };
  a._autoTitleChannel = async () => {};
  return a;
}

function valueAfter(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** The variadic list after `flag`, up to the next `--option`. */
function listAfter(args, flag) {
  const i = args.indexOf(flag);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < args.length && !String(args[j]).startsWith('--'); j++) out.push(args[j]);
  return out;
}

function noBypass(args) {
  for (const f of BYPASS_FLAGS) assert.ok(!args.includes(f), `unexpected ${f} in ${args.join(' ')}`);
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

function claude(agentName, extra = {}) {
  const a = make('claude', agentName, extra);
  a._findClaudeBinary = () => '/usr/local/bin/claude';
  return a;
}

function claudeCmd(a) {
  const built = a._buildClaudeCmd('hello', 'general', {});
  if (built.mcpConfigFile) { try { fs.unlinkSync(built.mcpConfigFile); } catch {} }
  return built.cmd;
}

describe('Claude Code — execute without the local opt-in', () => {
  it('skills mode: dontAsk, edits only in the working dir, Bash only in the sandbox', () => {
    const a = claude('alice', { toolMode: 'skills' });
    a._platform = () => 'darwin';
    const cmd = claudeCmd(a);
    noBypass(cmd);
    assert.equal(valueAfter(cmd, '--permission-mode'), 'dontAsk');
    assert.deepEqual(listAfter(cmd, '--allowedTools'),
      ['Edit(/**)', 'WebSearch', 'Skill(openagents-workspace-alice)']);
    for (const bare of ['Bash', 'Write', 'Edit', 'Read']) {
      assert.ok(!listAfter(cmd, '--allowedTools').includes(bare), `${bare} must not be pre-approved`);
    }
    const settings = JSON.parse(valueAfter(cmd, '--settings'));
    assert.equal(settings.sandbox.enabled, true);
    assert.equal(settings.sandbox.autoAllowBashIfSandboxed, true);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.deepEqual(settings.sandbox.network, {
      allowedDomains: ['workspace-endpoint.openagents.org'], strictAllowlist: true,
    });
    // This computer's own settings stay out of the agent's reach.
    assert.ok(settings.permissions.deny.includes(`Edit(/${path.join(configDir, 'policy.json')})`));
    assert.ok(settings.permissions.deny.includes(`Read(/${path.join(configDir, 'daemon.yaml')})`));
    // Other agents' folders are unreadable from the sandbox; its own is not.
    assert.ok(settings.sandbox.filesystem.denyRead.includes(path.join(configDir, 'agents')));
    assert.deepEqual(settings.sandbox.filesystem.allowRead, [a.workingDir]);
  });

  it('MCP mode: the workspace tools are pre-approved, nothing else is', () => {
    const a = claude('alice', { toolMode: 'mcp' });
    a._platform = () => 'linux';
    const cmd = claudeCmd(a);
    noBypass(cmd);
    assert.equal(valueAfter(cmd, '--permission-mode'), 'dontAsk');
    const allowed = listAfter(cmd, '--allowedTools');
    assert.ok(allowed.includes('mcp__openagents-workspace__workspace_write_file'));
    assert.ok(allowed.includes('Edit(/**)'));
    for (const bare of ['Bash', 'Write', 'Edit', 'Read']) assert.ok(!allowed.includes(bare));
    assert.ok(cmd.includes('--mcp-config'));
  });

  it('native Windows has no sandbox: Bash and PowerShell are removed', () => {
    const a = claude('alice', { toolMode: 'skills' });
    a._platform = () => 'win32';
    const cmd = claudeCmd(a);
    noBypass(cmd);
    const disallowed = listAfter(cmd, '--disallowedTools');
    assert.ok(disallowed.includes('Bash') && disallowed.includes('PowerShell'));
    const settings = JSON.parse(valueAfter(cmd, '--settings'));
    assert.equal(settings.sandbox, undefined);
  });
});

describe('Claude Code — with the local opt-in, and plan mode', () => {
  it('keeps --dangerously-skip-permissions for the opted-in agent only', () => {
    allow('alice');
    const alice = claudeCmd(claude('alice', { toolMode: 'skills' }));
    assert.ok(alice.includes('--dangerously-skip-permissions'));
    assert.deepEqual(listAfter(alice, '--allowedTools'), ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']);
    assert.ok(!alice.includes('--settings'));

    const bob = claudeCmd(claude('bob', { toolMode: 'skills' }));
    noBypass(bob);
    assert.equal(valueAfter(bob, '--permission-mode'), 'dontAsk');
  });

  it('plan mode is unchanged and never bypasses, opted in or not', () => {
    for (const optedIn of [false, true]) {
      if (optedIn) allow('alice');
      const a = claude('alice', { toolMode: 'skills' });
      a._mode = 'plan';
      const cmd = claudeCmd(a);
      noBypass(cmd);
      assert.equal(valueAfter(cmd, '--permission-mode'), 'plan');
      assert.deepEqual(listAfter(cmd, '--allowedTools'), ['Read', 'Glob', 'Grep', 'Bash']);

      const m = claude('alice', { toolMode: 'mcp' });
      m._mode = 'plan';
      const mcmd = claudeCmd(m);
      noBypass(mcmd);
      assert.equal(valueAfter(mcmd, '--permission-mode'), 'plan');
      assert.deepEqual(listAfter(mcmd, '--allowedTools').slice(-3), ['Read', 'Glob', 'Grep']);
    }
  });

  it('a persistent process spawned unrestricted is replaced once the opt-in is withdrawn', async () => {
    allow('alice');
    const a = claude('alice', { toolMode: 'skills' });
    const killed = [];
    const postures = [];
    a._fetchGlossary = async () => ({ error: true });
    a._buildChannelRecap = async () => null;
    a.getBrowserEnabled = async () => false;
    a._killPersistentProc = async (ch) => { killed.push(ch); delete a._persistentProcs[ch]; };
    a._buildClaudeCmd = (_p, _c, opts) => { postures.push(opts.posture); return { cmd: ['claude'] }; };
    a._spawnPersistentProc = (ch) => {
      const pp = { alive: true, lastResponseText: [], userStopped: false };
      a._persistentProcs[ch] = pp;
      return pp;
    };
    a._sendToPersistentProc = async () => ({ resultEvent: {} });
    a._composeFinalResponse = () => 'done';
    a._postTurnOutcome = async () => {};
    a._queueTodoNudge = async () => {};
    a._resetIdleTimer = () => {};

    await a._handleMessage({ content: 'one', sessionId: 'general' });
    assert.equal(postures[0].unrestricted, true);
    assert.equal(a._persistentProcs.general.spawnUnrestricted, true);

    // Withdrawn locally between two turns: the next turn must not reuse it.
    allow();
    await a._handleMessage({ content: 'two', sessionId: 'general' });
    assert.deepEqual(killed, ['general']);
    assert.equal(postures[1].unrestricted, false);
    assert.equal(a._persistentProcs.general.spawnUnrestricted, false);
  });
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function codex(agentName) {
  const a = make('codex', agentName, { agentEnv: { PATH: process.env.PATH, OPENAI_API_KEY: '' } });
  a._codexBin = '/usr/local/bin/codex';
  a._useCliMode = true;
  a._directMode = false;
  a._spawned = [];
  a._spawnCodex = async (cmd) => { a._spawned.push(cmd); return { responseText: 'ok', exitCode: 0 }; };
  return a;
}

async function codexTurn(a, channel = 'general') {
  await a._handleViaSubprocess('do it', channel, []);
  return a._spawned[a._spawned.length - 1];
}

describe('Codex', () => {
  it('approvalArgs: sandbox + never-prompting approvals; bypass only when allowed', () => {
    assert.deepEqual(CodexAdapter.approvalArgs({ mode: 'execute', unrestricted: false }), [
      '--sandbox', 'workspace-write',
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_workspace_write.network_access=true',
    ]);
    assert.deepEqual(CodexAdapter.approvalArgs({ mode: 'execute', unrestricted: true }),
      ['--dangerously-bypass-approvals-and-sandbox']);
    assert.deepEqual(CodexAdapter.approvalArgs({ mode: 'plan', unrestricted: true }),
      ['--sandbox', 'read-only', '-c', 'approval_policy="never"']);
    // Anything but a literal true is not an opt-in.
    noBypass(CodexAdapter.approvalArgs({ mode: 'execute', unrestricted: 'true' }));
  });

  it('execute without the opt-in runs in the workspace-write sandbox', async () => {
    const cmd = await codexTurn(codex('carol'));
    noBypass(cmd);
    assert.deepEqual(cmd.slice(1, 10), [
      'exec', '--json',
      '--sandbox', 'workspace-write',
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_workspace_write.network_access=true',
      '--skip-git-repo-check',
    ]);
  });

  it('a resumed turn keeps the sandbox flags ahead of `resume`', async () => {
    const a = codex('carol');
    a._channelThreads.general = 'thread-1';
    const cmd = await codexTurn(a);
    noBypass(cmd);
    const r = cmd.indexOf('resume');
    assert.ok(r > cmd.indexOf('--sandbox') && cmd[r + 1] === 'thread-1');
  });

  it('opt-in for carol bypasses for carol only', async () => {
    allow('carol');
    const carol = await codexTurn(codex('carol'));
    assert.ok(carol.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!carol.includes('--sandbox'));
    const dave = await codexTurn(codex('dave'));
    noBypass(dave);
    assert.equal(valueAfter(dave, '--sandbox'), 'workspace-write');
  });

  it('plan mode runs read-only even for an opted-in agent', async () => {
    allow('carol');
    const a = codex('carol');
    a._mode = 'plan';
    const cmd = await codexTurn(a);
    noBypass(cmd);
    assert.equal(valueAfter(cmd, '--sandbox'), 'read-only');
  });
});

// ---------------------------------------------------------------------------
// Nothing the workspace sends reaches a bypass flag
// ---------------------------------------------------------------------------

describe('remote paths cannot turn the controls off', () => {
  it('set_mode only switches between plan and execute', async () => {
    const a = codex('erin');
    const events = [
      { id: '1', payload: { action: 'set_mode', mode: 'bypassPermissions' } },
      { id: '2', payload: { action: 'set_mode', mode: 'unrestricted', unrestricted: true, yolo: true } },
      { id: '3', payload: { action: 'set_mode', mode: 'danger-full-access' } },
    ];
    a.client = { pollControl: async () => events };
    await a._pollControl();
    assert.equal(a._mode, 'execute');
    assert.equal(a._isUnrestricted(), false);
    noBypass(await codexTurn(a));

    a.client = { pollControl: async () => [{ id: '4', payload: { action: 'set_mode', mode: 'plan', unrestricted: true } }] };
    await a._pollControl();
    assert.equal(a._mode, 'plan');
    noBypass(await codexTurn(a));

    a.client = { pollControl: async () => [{ id: '5', payload: { action: 'set_mode', mode: 'execute', permissionMode: 'bypassPermissions' } }] };
    await a._pollControl();
    assert.equal(a._mode, 'execute');
    noBypass(await codexTurn(a));
  });

  it('adapter options a workspace might supply are ignored', () => {
    const a = claude('frank', {
      toolMode: 'skills',
      yolo: true,
      unrestricted: true,
      dangerouslySkipPermissions: true,
      permissionMode: 'bypassPermissions',
    });
    const cmd = claudeCmd(a);
    noBypass(cmd);
    assert.equal(valueAfter(cmd, '--permission-mode'), 'dontAsk');

    const h = make('hermes', 'frank', { yolo: true });
    h._hermesBin = '/usr/local/bin/hermes';
    assert.ok(!h._buildHermesCmd('hi', null).includes('--yolo'));
    allow('frank');
    assert.ok(h._buildHermesCmd('hi', null).includes('--yolo'), 'only the local opt-in turns on --yolo');
  });

  it('a configDir the workspace cannot write is the only source: a malformed policy allows nothing', () => {
    fs.writeFileSync(path.join(configDir, 'policy.json'), '{"unrestricted": "frank"');
    assert.equal(claude('frank')._isUnrestricted(), false);
    fs.writeFileSync(path.join(configDir, 'policy.json'), JSON.stringify({ unrestricted: 'frank' }));
    assert.equal(claude('frank')._isUnrestricted(), false);
  });

  it('agent env a workspace can write (configure_agent) never removes a sandbox', async () => {
    // Goose: GOOSE_MODE=auto is approvals off.
    const g = make('goose', 'gina', { agentEnv: { PATH: '', GOOSE_MODE: 'auto' } });
    assert.equal(g._buildEnv().GOOSE_MODE, 'chat');
    assert.equal(g._approvalGate().ok, false);
    // DeepSeek: danger-full-access is dsh without its sandbox.
    const d = make('deepseek', 'gina', { agentEnv: { PATH: '', DSH_PERMISSION_MODE: 'danger-full-access' } });
    assert.match(d._approvalGate().message, /agn policy unrestricted add gina/);
    const dw = make('deepseek', 'gina', { agentEnv: { PATH: '', DSH_PERMISSION_MODE: 'workspace-write' } });
    assert.equal(dw._approvalGate().ok, true);
    // OpenWorker: tool installs and bypass modes count only when allowed.
    const ow = make('openworker', 'gina', {
      agentEnv: { PATH: '', OPENWORKER_MODE: 'bypass-approvals', OPENWORKER_ALLOW_TOOL_INSTALL: '1' },
    });
    assert.equal(ow._approvalGate().ok, false);
    // Pi: PI_TRUST_PROJECT loads the project's own extensions (code).
    const p = make('pi', 'gina', { agentEnv: { PATH: '', PI_TRUST_PROJECT: '1' } });
    p._mode = 'plan';
    p._piBin = '/usr/local/bin/pi';
    let spawned = null;
    p._spawnPersistentProc = (_ch, opts) => { spawned = opts.args; return { alive: true }; };
    await p._ensureProc('general', p.workingDir, 'sys');
    assert.ok(spawned.includes('--no-approve') && !spawned.includes('--approve'));
    assert.equal(valueAfter(spawned, '--tools'), 'read,grep,find,ls');
  });
});

// ---------------------------------------------------------------------------
// Runtimes that only run unattended with approvals off refuse, actionably
// ---------------------------------------------------------------------------

describe('refusal for runtimes that cannot run safely unattended', () => {
  const REFUSING = [
    // type, refuses execute, refuses plan
    ['cline', true, true],
    ['mini-swe-agent', true, true],
    ['kimi', true, true],
    ['codearts', true, true],
    ['aider', true, false],
    ['codebuddy', true, false],
    ['commandcode', true, false],
    ['goose', true, false],
    ['openworker', true, false],
    ['pi', true, false],
  ];

  for (const [type, execRefused, planRefused] of REFUSING) {
    it(`${type}: refuses execute${planRefused ? ' and plan' : ''} without the opt-in, naming the command`, () => {
      const a = make(type, `${type}-agent`);
      const gate = a._approvalGate();
      assert.equal(gate.ok, !execRefused);
      assert.equal(gate.unrestricted, false);
      assert.ok(gate.message.endsWith(`run on this computer: agn policy unrestricted add ${type}-agent`), gate.message);
      a._mode = 'plan';
      assert.equal(a._approvalGate().ok, !planRefused);
    });
  }

  it('the opt-in for one agent does not reach another', () => {
    allow('cline-a');
    assert.deepEqual(make('cline', 'cline-a')._approvalGate(), { ok: true, mode: 'execute', unrestricted: true });
    const b = make('cline', 'cline-b')._approvalGate();
    assert.equal(b.ok, false);
    assert.match(b.message, /agn policy unrestricted add cline-b$/);
  });

  it('policy.json is read for every turn: a local change applies to the next one', () => {
    const a = make('mini-swe-agent', 'minnie');
    assert.equal(a._approvalGate().ok, false);
    allow('minnie');
    assert.equal(a._approvalGate().ok, true);
    allow();
    assert.equal(a._approvalGate().ok, false);
  });

  it('a refused turn reaches the channel and starts nothing', async () => {
    const m = make('mini-swe-agent', 'minnie');
    m._miniBin = '/usr/local/bin/mini';
    m._runMini = async () => { throw new Error('must not run'); };
    await m._handleMessage({ content: 'hi', sessionId: 'general' });
    assert.equal(m._sent.error.length, 1);
    assert.match(m._sent.error[0], /^mini-SWE-agent can only run unattended .* agn policy unrestricted add minnie$/);

    const c = make('cline', 'clio');
    c._findClineBinary = () => '/usr/local/bin/cline';
    c._checkClineVersion = () => ({ compatible: true, version: '3.0.60' });
    c._runCline = async () => { throw new Error('must not run'); };
    await c._handleMessage({ content: 'hi', sessionId: 'general' });
    assert.match(c._sent.error[0], /^Cline can only run unattended .* agn policy unrestricted add clio$/);
  });

  it('plan turns still build their runtime\'s read-only command', () => {
    const aider = make('aider', 'ada');
    aider._aiderBin = '/usr/local/bin/aider';
    aider._mode = 'plan';
    const cmd = aider._buildAiderCmd('general', '/tmp/msg', false);
    assert.equal(valueAfter(cmd, '--chat-mode'), 'ask');
    allow('ada');
    aider._mode = 'execute';
    assert.ok(!aider._buildAiderCmd('general', '/tmp/msg', false).includes('--chat-mode'));
  });
});

// ---------------------------------------------------------------------------
// Runtimes with a safe unattended mode use it by default
// ---------------------------------------------------------------------------

describe('safe defaults of the other runtimes', () => {
  it('Cursor: its sandbox, nothing force-allowed; --force only when allowed; --mode plan', () => {
    const c = make('cursor', 'cuthbert');
    c._findCursorBinary = () => '/usr/local/bin/cursor-agent';
    c._platform = () => 'darwin';
    let cmd = c._buildCursorCmd('hi', 'general');
    noBypass(cmd);
    assert.equal(valueAfter(cmd, '--sandbox'), 'enabled');
    assert.ok(cmd.includes('--trust'));
    c._platform = () => 'win32';
    cmd = c._buildCursorCmd('hi', 'general');
    noBypass(cmd);
    assert.ok(!cmd.includes('--sandbox'));
    c._mode = 'plan';
    cmd = c._buildCursorCmd('hi', 'general');
    assert.equal(valueAfter(cmd, '--mode'), 'plan');
    noBypass(cmd);
    c._mode = 'execute';
    allow('cuthbert');
    assert.ok(c._buildCursorCmd('hi', 'general').includes('--force'));
  });

  it('Copilot: writes in the working dir, no shell unless allowed', () => {
    const p = make('copilot', 'cora');
    let args = p._buildArgs('hi', 'general');
    assert.ok(args.includes('--allow-tool=write') && !args.includes('--allow-tool=shell'));
    assert.ok(args.includes('--no-ask-user'));
    allow('cora');
    args = p._buildArgs('hi', 'general');
    assert.ok(args.includes('--allow-tool=shell'));
  });

  it('Gemini: auto_edit (no shell); -y only when allowed; plan has neither', () => {
    assert.deepEqual(GeminiAdapter.approvalArgs({ mode: 'execute', unrestricted: false }), ['--approval-mode', 'auto_edit']);
    assert.deepEqual(GeminiAdapter.approvalArgs({ mode: 'execute', unrestricted: true }), ['-y']);
    assert.deepEqual(GeminiAdapter.approvalArgs({ mode: 'plan', unrestricted: true }), []);
  });

  it('Antigravity: agy soft-denies on its own; skip-permissions only when allowed', () => {
    noBypass(buildAgyArgv({ prompt: 'hi' }));
    const a = make('antigravity', 'agatha');
    a._ensureGeminiAuth = () => {};
    a._findAgyBinary = () => '/usr/local/bin/agy';
    noBypass(a._buildAgyCmd('hi', 'general').cmd);
    allow('agatha');
    assert.ok(a._buildAgyCmd('hi', 'general').cmd.includes('--dangerously-skip-permissions'));
    a._mode = 'plan';
    noBypass(a._buildAgyCmd('hi', 'general').cmd);
  });

  it('OpenCode: bash and leaving --dir are rejected, plan adds no edits; allowed agents keep their config', () => {
    assert.deepEqual(JSON.parse(OpenCodeAdapter.permissionEnv({ mode: 'execute', unrestricted: false }).OPENCODE_PERMISSION),
      { bash: 'ask', external_directory: 'ask' });
    assert.deepEqual(JSON.parse(OpenCodeAdapter.permissionEnv({ mode: 'plan', unrestricted: true }).OPENCODE_PERMISSION),
      { bash: 'ask', external_directory: 'ask', edit: 'deny' });
    assert.deepEqual(OpenCodeAdapter.permissionEnv({ mode: 'execute', unrestricted: true }), {});
    const o = make('opencode', 'otto');
    noBypass(o._buildRunArgs({ runCwd: tmp, model: 'p/m' }));
  });

  it('Cline builder never auto-approves without the opt-in', () => {
    assert.equal(valueAfter(buildClineArgs({ prompt: 'x' }), '--auto-approve'), 'false');
    assert.equal(valueAfter(buildClineArgs({ prompt: 'x', planMode: true }), '--auto-approve'), 'false');
  });
});

// ---------------------------------------------------------------------------
// Agent runtimes run marked unattended, so `agn` refuses them local-only acts
// ---------------------------------------------------------------------------

describe('OPENAGENTS_UNATTENDED in every agent runtime\'s environment', () => {
  const { ADAPTER_MAP } = require('../src/adapters');

  it('every adapter type carries it in the env its runtimes are spawned from', () => {
    for (const type of Object.keys(ADAPTER_MAP)) {
      const a = make(type, `${type}-env`, { agentEnv: { PATH: process.env.PATH, OPENAGENTS_UNATTENDED: '0' } });
      assert.equal(a.agentEnv.OPENAGENTS_UNATTENDED, '1', `${type}: a configured value cannot clear it`);
      a.agentEnv = { PATH: '' }; // adapters and tests reassign it
      assert.equal(a.agentEnv.OPENAGENTS_UNATTENDED, '1', `${type}: survives reassignment`);
    }
  });

  it('reaches the env handed to the spawned process', async () => {
    // Codex: the env _spawnCodex is given.
    const c = codex('una');
    let seen = null;
    c._spawnCodex = async (_cmd, env) => { seen = env; return { responseText: 'ok', exitCode: 0 }; };
    await c._handleViaSubprocess('hi', 'general', []);
    assert.equal(seen.OPENAGENTS_UNATTENDED, '1');
    // Claude: the child env built from it keeps it (only CLAUDE_* is stripped).
    assert.equal(ClaudeAdapter._buildChildEnv(claude('una').agentEnv).OPENAGENTS_UNATTENDED, '1');
    // Goose, mini, aider, OpenCode: their child-env builders.
    assert.equal(make('goose', 'una')._buildEnv().OPENAGENTS_UNATTENDED, '1');
    assert.equal(make('mini-swe-agent', 'una')._buildSubprocessEnv().OPENAGENTS_UNATTENDED, '1');
    assert.equal(make('aider', 'una')._buildSubprocessEnv().OPENAGENTS_UNATTENDED, '1');
    assert.equal(make('opencode', 'una')._spawnEnv().OPENAGENTS_UNATTENDED, '1');
    assert.equal(make('pi', 'una')._buildEnv().OPENAGENTS_UNATTENDED, '1');
  });
});
