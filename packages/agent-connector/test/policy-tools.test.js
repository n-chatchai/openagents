'use strict';

/**
 * `agn policy tools`: a person at this computer lets one agent call one tool
 * of an MCP server they connected (Erawan's, for Erawan Builder), and Claude
 * Code's execute mode is started with it pre-approved — and nothing else.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const policyLib = require('../src/policy');
const ClaudeAdapter = require('../src/adapters/claude');

const TOOL = 'mcp__claude_ai_Erawan_Cloud__deploy_files';
const local = { interactive: true, agentExists: (n) => n === 'claude-mac' };

function dir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pt-'));
}

describe('agn policy tools', () => {
  it('a person grants one tool to one agent, and can take it back', () => {
    const configDir = dir();
    let r = policyLib.runPolicyCommand(configDir, ['tools', 'add', 'claude-mac', TOOL], local);
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.deepEqual(policyLib.agentTools(policyLib.loadPolicy(configDir), 'claude-mac'), [TOOL]);
    assert.deepEqual(policyLib.agentTools(policyLib.loadPolicy(configDir), 'other'), []);
    r = policyLib.runPolicyCommand(configDir, ['show'], local);
    assert.ok(r.lines.some((l) => l.includes(`claude-mac: ${TOOL}`)));
    r = policyLib.runPolicyCommand(configDir, ['tools', 'remove', 'claude-mac', TOOL], local);
    assert.equal(r.code, 0);
    assert.deepEqual(policyLib.loadPolicy(configDir).tools, {});
  });

  it('only a whole MCP tool name, only for an agent that exists, only from a person', () => {
    const configDir = dir();
    for (const bad of ['Bash', 'mcp__erawan__*', 'mcp__erawan', 'Edit(/**)']) {
      assert.equal(policyLib.runPolicyCommand(configDir, ['tools', 'add', 'claude-mac', bad], local).code, 1, bad);
    }
    assert.equal(policyLib.runPolicyCommand(configDir, ['tools', 'add', 'ghost', TOOL], local).code, 1);
    assert.equal(policyLib.runPolicyCommand(configDir, ['tools', 'add', 'claude-mac', TOOL], { interactive: false }).code, 1);
    assert.equal(policyLib.runPolicyCommand(configDir, ['tools', 'add', 'claude-mac', TOOL], { ...local, unattended: true }).code, 1);
    assert.deepEqual(policyLib.loadPolicy(configDir).tools, {});
  });

  it('a hand-edited policy file cannot smuggle in anything but whole MCP tool names', () => {
    const configDir = dir();
    fs.writeFileSync(path.join(configDir, 'policy.json'),
      JSON.stringify({ tools: { 'claude-mac': ['Bash', TOOL, 'mcp__x__*'], other: 'nope' } }));
    assert.deepEqual(policyLib.loadPolicy(configDir).tools, { 'claude-mac': [TOOL] });
  });

  it("Claude Code's execute mode pre-approves the granted tool for that agent only", () => {
    const configDir = dir();
    policyLib.runPolicyCommand(configDir, ['tools', 'add', 'claude-mac', TOOL], local);
    const argsFor = (agentName) => ClaudeAdapter.prototype._safeExecuteArgs.call({
      configDir, agentName, endpoint: 'https://ws.example', workingDir: dir(), _platform: () => 'darwin',
    }, ['mcp__openagents-workspace__post'], null);
    const allowed = (args) => args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--settings'));
    assert.ok(allowed(argsFor('claude-mac')).includes(TOOL));
    assert.ok(allowed(argsFor('claude-mac')).includes('mcp__openagents-workspace__post'));
    assert.ok(!allowed(argsFor('someone-else')).includes(TOOL));
  });
});
