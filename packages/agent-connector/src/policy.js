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
 *   - configure (model, the agent's own key and endpoint) and remove those
 *     agents, and browse the managed folder for them (remove-agent,
 *     configure-agent, list-dir: on, and `agn policy deny <op>` turns each off);
 *   - nothing else: no folders outside `dirs` (create-in-dir: off, dirs:
 *     empty), no runtime installs (install-runtime: off, and even then only
 *     routes the installer can verify), no type-wide settings shared with
 *     agents of other workspaces, no setting that widens what an agent may do,
 *     and no agent running without its runtime's approval and sandbox controls.
 *
 * A computer paired before this policy existed gets these defaults too: an
 * upgrade grants nothing it did not already ask the person for, and takes
 * away what it never asked (custom folders, installs).
 *
 * The daemon reads it afresh for every remote command (src/daemon.js
 * _runNodeCommand). The `agn` children the daemon runs carry
 * OPENAGENTS_UNATTENDED=1, under which `agn policy` grants nothing.
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
  // Change an agent's settings (model, its own key and endpoint, its folder
  // within what create allows) from the workspace.
  'configure-agent': true,
  // List folders in the managed root (that workspace's agents only) and
  // inside `dirs`, for the workspace's folder picker.
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
    // Not remote ops a person can allow: what to do instead.
    dirs: 'agn policy dirs add <folder>',
    'agent-authority': 'agn policy unrestricted add <agent>, or change that setting in the agent\'s own settings on this computer',
    'install-unverified': 'agn install <type> --allow-unverified',
  }[op];
  return `This computer does not let the workspace ${hint || op}. On it, run: ${how || 'agn policy'}`;
}

// ---------------------------------------------------------------------------
// What a remote command may carry
// ---------------------------------------------------------------------------

/**
 * Agent names a remote create may use: letters, digits, '_', '-' and '.',
 * starting with a letter, digit or '_'. A name is also an argv word for the
 * `agn` child and a folder under the managed root, so a leading '-' (read as
 * a flag), a path separator or '.'/'..' never gets that far.
 */
const AGENT_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function isSafeAgentName(name) {
  return typeof name === 'string' && AGENT_NAME_RE.test(name);
}

/**
 * Agent type names: what every registry entry uses. A type becomes a folder
 * (~/.openagents/runtimes/<type>), a file (env/<type>.env) and an argv word,
 * and a catalog a server sends can list any name — so one with a separator,
 * '..' or a leading '-' is no type at all.
 */
const AGENT_TYPE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function isSafeTypeName(type) {
  return typeof type === 'string' && AGENT_TYPE_RE.test(type);
}

/** Fields a remote command carries as text; config values are checked too. */
const TEXT_ARGS = ['name', 'type', 'workingDir', 'currentWorkingDir', 'apiKey', 'baseUrl', 'model', 'authMode',
  'codexWireApi', 'path'];

/**
 * Fields whose value this computer cannot store as sent: not text (or a
 * number/boolean where config takes one), or text with control characters,
 * which the config and env files would read back as something else. Names
 * only — never values.
 */
function unstorableFields(args) {
  const bad = [];
  const textOk = (v) => typeof v === 'string' && !/[\u0000-\u001f\u007f]/.test(v);
  for (const key of TEXT_ARGS) {
    if (!args || args[key] === undefined || args[key] === null) continue;
    if (!textOk(args[key])) bad.push(key);
  }
  const config = args && args.config;
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    for (const [key, value] of Object.entries(config)) {
      if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') continue;
      if (!textOk(value)) bad.push(`config.${key}`);
    }
  }
  return bad;
}

/**
 * Registry env_config keys that change how far an agent may act, with the
 * values a workspace may still send: ones that narrow it. Anything else (a
 * bypass mode, a path the agent's runtime would load code or credentials
 * from) is set on this computer or not at all.
 */
const AUTHORITY_ENV = Object.freeze({
  DSH_PERMISSION_MODE: Object.freeze(['read-only', 'workspace-write']),
  OPENWORKER_MODE: Object.freeze(['plan', 'interactive']),
  OPENWORKER_ALLOW_TOOL_INSTALL: Object.freeze(['0', '']),
  PI_TRUST_PROJECT: Object.freeze(['0', '']),
  GOOSE_MODE: Object.freeze(['chat']),
  OPENWORKER_STATE_DIR: Object.freeze([]),
  NANOCLAW_HOME: Object.freeze([]),
  MSWEA_MINI_CONFIG_PATH: Object.freeze([]),
});

/**
 * Env names that change how a process loads code, where it looks for things
 * or whom it trusts. No registry entry declares one; a catalog a server sends
 * might, and a workspace never sets one.
 */
const PROCESS_ENV = /^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|LD_[A-Z0-9_]+|DYLD_[A-Z0-9_]+|PATH|PATHEXT|COMSPEC|PYTHON[A-Z0-9_]*|PERL5?LIB|PERL5OPT|RUBYOPT|RUBYLIB|BASH_ENV|ENV|SHELL|SHELLOPTS|PS4|PROMPT_COMMAND|GIT_[A-Z0-9_]+|SSH_[A-Z0-9_]+|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_[A-Z0-9_]+|TMPDIR|TEMP|TMP|NPM_CONFIG_[A-Z0-9_]+|UV_[A-Z0-9_]+|PIP_[A-Z0-9_]+|OPENAGENTS_[A-Z0-9_]+|OA_[A-Z0-9_]+|ELECTRON_[A-Z0-9_]+|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_[A-Z0-9_]+|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/i;

function isProcessEnvKey(key) {
  return PROCESS_ENV.test(String(key || ''));
}

/** Whether a workspace may set env key `key` to `value` on an agent. */
function remoteEnvValueAllowed(key, value) {
  if (isProcessEnvKey(key)) return false;
  if (!Object.prototype.hasOwnProperty.call(AUTHORITY_ENV, key)) return true;
  if (value === null || value === undefined) return true; // not sent: nothing changes
  return AUTHORITY_ENV[key].includes(String(value).trim());
}

/** The arguments each remote action reads. Anything else has no effect. */
const REMOTE_ARGS = Object.freeze({
  create_agent: ['name', 'type', 'workingDir', 'apiKey', 'baseUrl', 'model', 'config', 'authMode',
    'useDeviceCredentials', 'codexWireApi', 'modelAccessId'],
  configure_agent: ['name', 'type', 'workingDir', 'currentWorkingDir', 'apiKey', 'baseUrl', 'model', 'config',
    'authMode', 'useDeviceCredentials', 'codexWireApi', 'modelAccessId'],
  start_agent: ['name', 'type'],
  stop_agent: ['name', 'type'],
  remove_agent: ['name', 'type'],
  probe_agent: ['name', 'type'],
  list_models: ['name', 'type'],
  list_dir: ['path'],
  detect_runtimes: [],
});

/** Argument names that ask for more authority than pairing gives. */
const AUTHORITY_ARG = /unrestricted|yolo|dangerous|skip.?perm|bypass|permission|approv|sandbox|unverified|policy|trust|tool.?mode|full.?access|allow.?all|^env$|^install/i;

/**
 * Sort a remote command's arguments into what is refused (they would widen
 * what this computer lets the workspace or an agent do) and what is merely
 * ignored (fields this launcher does not read, env keys outside the type's
 * env_config). `envConfig` is the type's env_config key set, or null.
 * Field names only — never values, which can be secrets.
 */
function screenRemoteArgs(action, args, envConfig) {
  const refused = [];
  const ignored = [];
  const known = new Set(REMOTE_ARGS[action] || []);
  for (const key of Object.keys(args || {})) {
    if (known.has(key)) continue;
    (AUTHORITY_ARG.test(key) ? refused : ignored).push(key);
  }
  const config = args && args.config;
  if (known.has('config') && config !== undefined && config !== null) {
    if (typeof config !== 'object' || Array.isArray(config)) {
      ignored.push('config');
    } else {
      for (const [key, value] of Object.entries(config)) {
        if (!remoteEnvValueAllowed(key, value)) refused.push(`config.${key}`);
        else if (envConfig && !envConfig.has(key)) ignored.push(`config.${key}`);
      }
    }
  }
  if (known.has('authMode') && args.authMode !== undefined && args.authMode !== 'cli_login') ignored.push('authMode');
  return { refused, ignored };
}

// ---------------------------------------------------------------------------
// Folders a remote command may use
// ---------------------------------------------------------------------------

/** Folders a remote command may reach: the managed root, then each listed folder that exists. */
function allowedRoots(policy, configDir) {
  const roots = [managedAgentsRoot(configDir)];
  for (const d of (policy && policy.dirs) || []) {
    try { if (fs.statSync(d).isDirectory() && !roots.includes(d)) roots.push(d); } catch {}
  }
  return roots;
}

/** A path a workspace sent, checked for shape only: absolute, no NUL. */
function remotePath(requested) {
  const raw = typeof requested === 'string' ? requested.trim() : '';
  if (!raw) return { empty: true };
  if (raw.includes('\0') || !path.isAbsolute(raw)) {
    return { refused: 'The workspace has to name a full folder path on this computer.' };
  }
  return { raw: path.resolve(raw), real: resolveReal(raw) };
}

/**
 * The working folder a remote create (or a configure that moves an agent)
 * may give agent `name`: `{ dir }`, or `{ refused: message }`.
 *
 * No folder, or the managed root itself, is the agent's own managed folder
 * (<configDir>/agents/<name>). Inside the managed root an agent may only use
 * its own folder: another agent's belongs to it, and maybe to another
 * workspace. OpenAgents' own settings folder is never a working folder.
 * Anywhere else needs `create-in-dir` and a folder listed in `dirs`.
 */
function remoteWorkingDir(policy, configDir, name, requested) {
  const managed = path.join(managedAgentsRoot(configDir), name);
  const p = remotePath(requested);
  if (p.empty) return { dir: managed, managed: true };
  if (p.refused) return p;
  const root = resolveReal(managedAgentsRoot(configDir));
  if (p.real === root) return { dir: managed, managed: true };
  if (isInside(p.real, root)) {
    if (isInside(p.real, resolveReal(managed))) return { dir: p.raw, managed: true };
    return { refused: `'${p.raw}' belongs to another agent on this computer.` };
  }
  if (isInside(p.real, resolveReal(configDir))) {
    return { refused: `'${p.raw}' is inside OpenAgents' own settings folder, which no agent may work in.` };
  }
  if (!isDirAllowed(policy, configDir, p.raw)) {
    return { refused: refusal('create-in-dir', `create agents in ${p.raw}`) };
  }
  if (!isRemoteAllowed(policy, 'create-in-dir')) {
    return { refused: refusal('create-in-dir', `create agents in a folder of its choice (${p.raw})`) };
  }
  return { dir: p.raw };
}

/**
 * The folder a remote list_dir may list: `{ dir, only?, within }` or
 * `{ refused }`. `ownNames` are the agents bound to the asking workspace: in
 * the managed root it sees only their folders, never another workspace's.
 * `within(dir)` says whether a parent folder may be offered to go up to.
 */
function remoteListTarget(policy, configDir, requested, ownNames = []) {
  if (!isRemoteAllowed(policy, 'list-dir')) return { refused: refusal('list-dir', 'browse folders') };
  const rootPath = managedAgentsRoot(configDir);
  const p = remotePath(requested || rootPath);
  if (p.refused) return p;
  const root = resolveReal(rootPath);
  const config = resolveReal(configDir);
  const listed = ((policy && policy.dirs) || []).map(resolveReal);
  const within = (dir) => {
    const real = resolveReal(dir);
    if (real === root) return true;
    if (isInside(real, root)) return ownNames.includes(path.relative(root, real).split(path.sep)[0]);
    if (isInside(real, config)) return false;
    return listed.some((d) => isInside(real, d));
  };
  if (p.real === root) return { dir: p.real, only: ownNames, within };
  if (isInside(p.real, root)) {
    const owner = path.relative(root, p.real).split(path.sep)[0];
    if (!ownNames.includes(owner)) return { refused: `'${p.raw}' belongs to an agent this workspace does not manage.` };
    return { dir: p.real, within };
  }
  if (isInside(p.real, config) || !listed.some((d) => isInside(p.real, d))) {
    return { refused: refusal('dirs', `browse ${p.raw}`) };
  }
  return { dir: p.real, within };
}

// ---------------------------------------------------------------------------
// `agn policy` — the only writer
// ---------------------------------------------------------------------------

const OP_HELP = Object.freeze({
  'create-in-dir': 'create an agent in a folder listed under dirs, not only in its own managed folder',
  'install-runtime': 'install an agent runtime this launcher can verify (a pinned npm package and its checksum)',
  'remove-agent': 'remove one of its agents from this computer (its folder is left as it is)',
  'configure-agent': "change one of its agents' model, key, endpoint or folder",
  'list-dir': 'browse the managed folder and the folders under dirs, for its folder picker',
});

const POLICY_USAGE = [
  'Usage:',
  '  agn policy show [--json]',
  '  agn policy allow <op>              let a paired workspace do <op>',
  '  agn policy deny <op>',
  '  agn policy dirs add <folder>       a folder workspaces may create agents in and browse',
  '  agn policy dirs remove <folder>',
  '  agn policy unrestricted add <agent>     let one agent run without its runtime\'s approvals',
  '  agn policy unrestricted remove <agent>',
  `Operations: ${Object.keys(REMOTE_OPS).join(', ')}`,
];

/**
 * Run `agn policy <argv…>` against configDir. Only a person at this computer
 * grants authority: a grant run under the daemon (`ctx.unattended`) or with no
 * interactive terminal (`!ctx.interactive`, which is how an agent's shell tool
 * runs a command) is refused. Taking authority away works from anywhere.
 *
 * @param {string} configDir
 * @param {string[]} argv            the words after `policy`
 * @param {{interactive?: boolean, unattended?: boolean, json?: boolean,
 *          agentExists?: (name: string) => boolean}} ctx
 * @returns {{ lines: string[], code: number }}
 */
function runPolicyCommand(configDir, argv = [], ctx = {}) {
  const lines = [];
  const say = (l = '') => lines.push(l);
  const done = (code = 0) => ({ lines, code });
  const policy = loadPolicy(configDir);
  const save = () => savePolicy(configDir, policy);
  const grantRefused = (what) => {
    if (ctx.unattended) return `Refused: ${what} was asked for by the OpenAgents daemon or something it runs, not by a person at this computer.`;
    if (!ctx.interactive) return `Refused: ${what} needs a person at this computer. Run it in an interactive terminal.`;
    return null;
  };
  const opArg = (op) => {
    if (Object.prototype.hasOwnProperty.call(REMOTE_OPS, op)) return op;
    say(op ? `Unknown operation '${op}'.` : 'Name an operation.');
    say(`Operations: ${Object.keys(REMOTE_OPS).join(', ')}`);
    return null;
  };
  const [sub = 'show', a, b] = argv;
  const root = managedAgentsRoot(configDir);

  if (sub === 'show') {
    if (ctx.json) {
      say(JSON.stringify({ file: policyFile(configDir), managedRoot: root, ...policy }, null, 2));
      return done();
    }
    say(`What a paired workspace may do on this computer (${policyFile(configDir)})`);
    say('');
    say('Always: start, stop, test and list the models of the agents bound to that workspace, and');
    say(`create an agent in its own managed folder (${path.join(root, '<name>')}) without installing anything.`);
    say('');
    say('Operations:');
    const width = Math.max(...Object.keys(REMOTE_OPS).map((op) => op.length));
    for (const op of Object.keys(REMOTE_OPS)) {
      say(`  ${op.padEnd(width)}  ${isRemoteAllowed(policy, op) ? 'allowed' : 'denied '}  ${OP_HELP[op]}`);
    }
    say('');
    say('Folders (dirs):');
    if (!policy.dirs.length) say(`  none — only the managed folder ${root}`);
    for (const d of policy.dirs) say(`  ${d}`);
    say('');
    say("Unrestricted agents (run without their runtime's approvals and sandbox):");
    if (!policy.unrestricted.length) say('  none');
    for (const n of policy.unrestricted) say(`  ${n}`);
    say('');
    say('Change it: agn policy allow|deny <op> · agn policy dirs add|remove <folder> · agn policy unrestricted add|remove <agent>');
    return done();
  }

  if (sub === 'allow' || sub === 'deny') {
    const op = opArg(a);
    if (!op) return done(1);
    if (sub === 'allow') {
      const refused = grantRefused(`allowing ${op}`);
      if (refused) { say(refused); return done(1); }
    }
    policy.remote[op] = sub === 'allow';
    save();
    say(`${sub === 'allow' ? 'Allowed' : 'Denied'}: a paired workspace may ${sub === 'allow' ? 'now' : 'no longer'} ${OP_HELP[op]}.`);
    if (sub === 'allow' && op === 'create-in-dir' && !policy.dirs.length) {
      say('No folder is listed yet: add one with agn policy dirs add <folder>.');
    }
    return done();
  }

  if (sub === 'dirs') {
    if ((a !== 'add' && a !== 'remove') || !b) { POLICY_USAGE.forEach((l) => say(l)); return done(1); }
    if (a === 'add') {
      let real;
      try {
        real = fs.realpathSync(path.resolve(b));
        if (!fs.statSync(real).isDirectory()) throw new Error('not a folder');
      } catch {
        say(`'${b}' is not a folder on this computer.`);
        return done(1);
      }
      if (isInside(real, resolveReal(configDir))) {
        say(`'${real}' is inside OpenAgents' own settings folder; agents get their managed folder there already.`);
        return done(1);
      }
      const refused = grantRefused(`adding ${real}`);
      if (refused) { say(refused); return done(1); }
      if (policy.dirs.includes(real)) { say(`Already listed: ${real}`); return done(); }
      policy.dirs.push(real);
      save();
      say(`Added: ${real}`);
      if (path.dirname(real) === real) {
        say('Warning: that is a whole drive. A workspace allowed create-in-dir can then put an agent in any folder on it.');
      } else if (real === resolveReal(os.homedir())) {
        say('Warning: that is your whole home folder. A workspace allowed create-in-dir can then put an agent in any folder in it.');
      }
      if (!isRemoteAllowed(policy, 'create-in-dir')) {
        say('Workspaces may browse it now; to let them create agents there too: agn policy allow create-in-dir');
      }
      return done();
    }
    const resolved = path.resolve(b);
    const real = resolveReal(b);
    const before = policy.dirs.length;
    policy.dirs = policy.dirs.filter((d) => d !== real && d !== resolved);
    if (policy.dirs.length === before) { say(`Not listed: ${resolved}`); return done(); }
    save();
    say(`Removed: ${real === resolved ? real : `${resolved} (${real})`}. Agents already working there keep their folder.`);
    return done();
  }

  if (sub === 'unrestricted') {
    if ((a !== 'add' && a !== 'remove') || !b) { POLICY_USAGE.forEach((l) => say(l)); return done(1); }
    if (a === 'add') {
      // Only an agent that exists now: a name listed ahead of time could be
      // claimed by the next agent a workspace creates under it.
      if (ctx.agentExists && !ctx.agentExists(b)) {
        say(`No agent named '${b}' on this computer. Create it first; then allow it.`);
        return done(1);
      }
      const refused = grantRefused(`letting '${b}' run unrestricted`);
      if (refused) { say(refused); return done(1); }
      say(`WARNING: '${b}' will run without its runtime's approval prompts and sandbox.`);
      say('Whatever a message in its workspace asks for, it can do with your account on this computer:');
      say('read and change any file you can, run any command, and use the credentials saved here.');
      say('Only do this for an agent whose workspace you trust with all of that.');
      if (policy.unrestricted.includes(b)) { say(`Already unrestricted: ${b}`); return done(); }
      policy.unrestricted.push(b);
      save();
      say(`Unrestricted: ${b}. It takes effect the next time the agent starts. Undo with: agn policy unrestricted remove ${b}`);
      return done();
    }
    const before = policy.unrestricted.length;
    policy.unrestricted = policy.unrestricted.filter((n) => n !== b);
    if (policy.unrestricted.length === before) { say(`'${b}' was not unrestricted.`); return done(); }
    save();
    say(`'${b}' runs with its runtime's approvals and sandbox again from its next start.`);
    return done();
  }

  POLICY_USAGE.forEach((l) => say(l));
  return done(1);
}

module.exports = {
  POLICY_VERSION,
  REMOTE_OPS,
  AUTHORITY_ENV,
  REMOTE_ARGS,
  defaultPolicy,
  policyFile,
  managedAgentsRoot,
  loadPolicy,
  savePolicy,
  isRemoteAllowed,
  isDirAllowed,
  isUnrestricted,
  isSafeAgentName,
  isSafeTypeName,
  unstorableFields,
  remoteEnvValueAllowed,
  isProcessEnvKey,
  screenRemoteArgs,
  allowedRoots,
  remoteWorkingDir,
  remoteListTarget,
  refusal,
  resolveReal,
  isInside,
  runPolicyCommand,
  homedir: () => os.homedir(),
};
