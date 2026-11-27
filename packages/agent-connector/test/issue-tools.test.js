// Issues for agents through the connector: two MCP tools and the curl lines (founder, 2026-11-27).
const test = require('node:test');
const assert = require('node:assert');
const { McpServer } = require('../src/mcp-server');
const { buildApiSkillsPrompt } = require('../src/adapters/workspace-prompt');

test('workspace_create_issue posts to /v1/bot-tools/agent with the thread and the asker', async () => {
  const calls = [];
  const ws = { issueTool: async (wid, token, body) => { calls.push({ wid, token, body }); return { ok: true, text: 'Opened issue #3' }; } };
  const s = new McpServer({ wsClient: ws, workspaceId: 'w1', channelName: 'channel-a', agentName: 'claude', token: 't', requesterEmail: 'a@b.test' });
  assert.ok(s.tools.some((t) => t.name === 'workspace_create_issue'));
  const out = await s._dispatch('workspace_create_issue', { title: 'x', assignee: 'asker' });
  assert.strictEqual(out.content[0].text, 'Opened issue #3');
  assert.deepStrictEqual(calls[0].body, { agentName: 'claude', channel: 'channel-a', requester: 'a@b.test', tool: 'workspace_create_issue', args: { title: 'x', assignee: 'asker' } });
});

test('a refusal comes back as an error', async () => {
  const ws = { issueTool: async () => ({ ok: false, text: 'No board is named "X".' }) };
  const s = new McpServer({ wsClient: ws, workspaceId: 'w1', channelName: 'channel-a', agentName: 'claude', token: 't' });
  const out = await s._dispatch('workspace_create_issue', { title: 'x', board: 'X' });
  assert.strictEqual(out.isError, true);
});

test('the curl skill names the issue endpoint', () => {
  const p = buildApiSkillsPrompt({ endpoint: 'https://w.test', workspaceId: 'w1', token: 't', agentName: 'claude', channelName: 'CURRENT_CHANNEL', disabledModules: new Set() });
  assert.match(p, /\/v1\/bot-tools\/agent\?network=w1/);
});
