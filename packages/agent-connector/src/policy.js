'use strict';

/**
 * What this computer lets a paired workspace do — decided here, never remotely.
 *
 * Pairing a device gives a workspace a credential, not authority: the commands
 * a workspace sends over the heartbeat (create, configure, remove an agent,
 * list a folder, install a runtime) are checked against this policy when they
 * run, and nothing a workspace sends can change it. It lives in
 * ~/.openagents/policy.json (mode 0600), written only by `agn policy` on this
 * computer.
 *
 * Defaults are what pairing alone allows:
 *   - start, stop, probe and list models of agents already bound to that
 *     workspace, and create one in a managed folder under
 *     ~/.openagents/agents/<name> without installing anything;
 *   - nothing else: no folders outside `dirs`, no runtime installs, no
 *     reconfiguring an agent's type-wide credentials, and no agent running
 *     without its runtime's approval and sandbox controls.
 *
 * A computer paired before this policy existed gets these defaults too: an
 * upgrade grants nothing it did not already ask the person for.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const POLICY_VERSION = 1;

/** Remote operations a person can allow with `agn policy allow <op>`. */
const REMOTE_OPS = Object.freeze({
  // Create an agent in a folder the person listed in `dirs` (not only the
  // managed one).
  'create-in-dir': false,
  // Install or update an agent runtime on this computer.
  'install-runtime': false,
  // Remove an agent bound to the workspace from this computer's config.
  'remove-agent': true,
  // Change an agent's settings (model, its own key) from the workspace.
  'configure-agent': true,
  // List folders inside `dirs` for the workspace's folder picker.
  'list-dir': true,
});

function defaultPolicy() {
  return {
    version: POLICY_VERSION,
    remote: { ...REMOTE_OPS },
    // Folders remote operations may use, besides each agent's managed folder.
    dirs: [],
    // Agents this person allowed to run without their runtime's approval and
    // sandbox controls (`agn policy unrestricted add <agent>`).
    unrestricted: [],
  };
}

function policyFile(configDir) {
  return path.join(configDir, 'policy.json');
}

function managedAgentsRoot(configDir) {
  return path.join(configDir, 'agents');
}

/**
 * The policy in force. A missing file is the defaults; an unreadable or
 * malformed one is the defaults too, never something looser.
 */
function loadPolicy(configDir) {
  const base = defaultPolicy();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(policyFile(configDir), 'utf-8'));
  } catch {
    return base;
  }
  if (!raw || typeof raw !== 'object') return base;
  const remote = { ...base.remote };
  if (raw.remote && typeof raw.remote === 'object') {
    for (const op of Object.keys(REMOTE_OPS)) {
      if (typeof raw.remote[op] === 'boolean') remote[op] = raw.remote[op];
    }
  }
  const dirs = Array.isArray(raw.dirs)
    ? raw.dirs.filter((d) => typeof d === 'string' && path.isAbsolute(d))
    : [];
  const unrestricted = Array.isArray(raw.unrestricted)
    ? raw.unrestricted.filter((n) => typeof n === 'string' && n)
    : [];
  return { version: POLICY_VERSION, remote, dirs, unrestricted };
}

/** Write the policy (local callers only: `agn policy`). */
function savePolicy(configDir, policy) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const file = policyFile(configDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(policy, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function isRemoteAllowed(policy, op) {
  if (!Object.prototype.hasOwnProperty.call(REMOTE_OPS, op)) return false;
  return !!(policy && policy.remote && policy.remote[op] === true);
}

/** realpath of `p`, or of its nearest existing parent with the rest appended. */
function resolveReal(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function isInside(child, root) {
  const rel = path.relative(root, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Whether a remote operation may use `dir`: inside the agents' managed root,
 * or inside a folder the person listed. Symlinks and `..` are resolved first,
 * so neither can lead outside.
 */
function isDirAllowed(policy, configDir, dir, { managedOnly = false } = {}) {
  if (typeof dir !== 'string' || !dir.trim() || !path.isAbsolute(dir.trim())) return false;
  const real = resolveReal(dir.trim());
  const roots = [managedAgentsRoot(configDir)];
  if (!managedOnly) roots.push(...((policy && policy.dirs) || []));
  return roots.some((root) => isInside(real, resolveReal(root)));
}

function isUnrestricted(policy, agentName) {
  return !!(policy && Array.isArray(policy.unrestricted) && policy.unrestricted.includes(agentName));
}

/** The message a refused remote operation reports back to the workspace. */
function refusal(op, hint) {
  const how = {
    'create-in-dir': 'agn policy dirs add <folder> && agn policy allow create-in-dir',
    'install-runtime': 'agn policy allow install-runtime (or install it yourself with agn install <type>)',
    'remove-agent': 'agn policy allow remove-agent',
    'configure-agent': 'agn policy allow configure-agent',
    'list-dir': 'agn policy allow list-dir',
  }[op];
  return `This computer does not let the workspace ${hint || op}. On it, run: ${how || 'agn policy'}`;
}

module.exports = {
  POLICY_VERSION,
  REMOTE_OPS,
  defaultPolicy,
  policyFile,
  managedAgentsRoot,
  loadPolicy,
  savePolicy,
  isRemoteAllowed,
  isDirAllowed,
  isUnrestricted,
  refusal,
  resolveReal,
  isInside,
  homedir: () => os.homedir(),
};
