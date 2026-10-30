'use strict';

const fs = require('fs');
const path = require('path');
const policy = require('./env-policy');
const fsProtect = require('./fs-protect');
const { CredentialStoreError, defaultCredentialStore } = require('./credential-store');

const { EnvValidationError } = policy;

// Warnings are said once per process: load() runs on every heartbeat.
const warnedOnce = new Set();

function defaultWarn(message) {
  try { process.stderr.write(`[openagents] ${message}\n`); } catch {}
}

/** Why a store call failed, in words that never carry the secret. */
function storeReason(err) {
  return err instanceof CredentialStoreError ? err.message : 'credential store error';
}

const LOCK_STALE_MS = 30000;

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

/**
 * Manages ~/.openagents/env/<type>.env files and resolve_env rules.
 *
 * Env files use key=value format (one per line, # for comments).
 * resolve_env maps generic LLM_* vars to provider-specific vars
 * (e.g. LLM_API_KEY → OPENAI_API_KEY or ANTHROPIC_API_KEY).
 *
 * What may be saved is env-policy.js's: save() refuses an invalid key, a
 * runtime-control variable or a value with a line break before anything is
 * written, and load() leaves out whatever an older version let into the file.
 *
 * Secrets (policy.isSecretKey) live in the OS credential store
 * (credential-store.js); the file keeps `KEY=@credential:<id>` and load()
 * resolves it. A plaintext secret found in a file is moved there the first
 * time it is loaded or saved: written to the store, read back and compared,
 * and only then replaced in the file. Without a usable store (headless Linux,
 * a locked keychain, OPENAGENTS_CREDENTIAL_STORE=file) it stays in the file.
 * The directory is 0700 and the files 0600 (a user-only ACL on Windows), and
 * every write is atomic.
 *
 * opts (for tests and embedding): { credentialStore, warn, fsOptions }.
 */
class EnvManager {
  constructor(configDir, opts = {}) {
    this.configDir = configDir;
    this.envDir = path.join(configDir, 'env');
    this._store = opts.credentialStore || null;
    this._warn = opts.warn || defaultWarn;
    this._warned = opts.warn ? new Set() : warnedOnce;
    this._fsOptions = opts.fsOptions || {};
    // Secrets whose move to the store failed in this process: not retried on
    // every load (each attempt is a child process).
    this._migrationFailed = new Set();
  }

  /**
   * Load env vars from ~/.openagents/env/<agentType>.env
   */
  load(agentType) {
    if (!policy.isValidAgentType(agentType)) {
      this._warnOnce(`type:${agentType}`, `ignoring env for invalid agent type ${policy.describeName(agentType)}`);
      return {};
    }
    let raw;
    try { raw = this._readRaw(agentType); } catch { return {}; }
    if (!raw) return {};
    this._protectExisting(agentType);
    const env = {};
    const plaintextSecrets = [];
    for (const [key, value] of raw.entries) {
      if (policy.isCredentialReference(value)) {
        const resolved = this._resolveReference(agentType, key, value);
        if (resolved !== null) env[key] = resolved;
        continue;
      }
      env[key] = value;
      if (value && policy.isSecretKey(key)) plaintextSecrets.push(key);
    }
    if (plaintextSecrets.length) {
      try { this._migrate(agentType, raw, plaintextSecrets); } catch {}
    }
    return env;
  }

  /**
   * Save env vars to ~/.openagents/env/<agentType>.env
   * Merges with existing values (new values override). A null, undefined or
   * empty value removes the key. Throws EnvValidationError (code ENV_INVALID)
   * before writing anything when a key or value is refused.
   */
  save(agentType, env) {
    policy.validateAgentType(agentType);
    const updates = policy.validateEnvUpdates(env);
    fsProtect.ensurePrivateDir(this.envDir, this._fsOptions);
    this._withLock(agentType, { wait: true }, () => this._saveLocked(agentType, updates));
  }

  /**
   * Delete env file for an agent type, and the store entries it referred to.
   */
  delete(agentType) {
    if (!policy.isValidAgentType(agentType)) return;
    let raw = null;
    try { raw = this._readRaw(agentType); } catch {}
    try { fs.unlinkSync(this._file(agentType)); } catch {}
    if (!raw) return;
    const store = this._readStore();
    for (const value of raw.entries.values()) {
      if (policy.isCredentialReference(value) && !this._refInUse(value)) this._deleteStored(store, value);
    }
  }

  /**
   * Apply resolve_env rules to map generic vars to provider-specific vars.
   *
   * Rules format (from YAML plugin definition):
   *   { from: 'LLM_API_KEY', to: 'OPENAI_API_KEY', unless_base_url_contains: 'anthropic' }
   *   { from: 'LLM_API_KEY', to: 'ANTHROPIC_API_KEY', if_base_url_contains: 'anthropic' }
   *   { from: 'LLM_BASE_URL', to: 'OPENAI_BASE_URL' }
   *
   * @param {object} saved - The saved env vars (from the env file)
   * @param {object[]} rules - The resolve_env rules from the registry
   * @returns {object} - The resolved env vars (provider-specific)
   */
  resolve(agentType, saved, registry) {
    const rules = registry ? registry.getResolveRules(agentType) : [];
    if (!rules || rules.length === 0) return saved;

    const resolved = {};
    const baseUrl = (saved.LLM_BASE_URL || '').toLowerCase();

    for (const rule of rules) {
      const src = rule.from || '';
      const dst = rule.to || '';
      let srcVal = saved[src];
      if (!srcVal || !dst) continue;

      // Conditional rules based on base URL
      if (rule.if_base_url_contains) {
        if (!baseUrl.includes(rule.if_base_url_contains.toLowerCase())) continue;
      }
      if (rule.unless_base_url_contains) {
        if (baseUrl.includes(rule.unless_base_url_contains.toLowerCase())) continue;
      }

      if (dst === 'ANTHROPIC_BASE_URL') srcVal = normalizeAnthropicBase(srcVal);
      resolved[dst] = srcVal;
    }

    return resolved;
  }

  /**
   * Get the full effective env for an agent: saved + resolved. Nothing the
   * policy refuses survives, whichever rule or file put it there (the
   * registry, and with it resolve_env, can come from the network).
   */
  getEffective(agentType, registry) {
    const saved = { ...this.load(agentType) };
    // Same normalization as resolve(), for a base saved under the provider
    // key directly (agn env --set ANTHROPIC_BASE_URL=…, hand-edited files).
    if (saved.ANTHROPIC_BASE_URL) {
      saved.ANTHROPIC_BASE_URL = normalizeAnthropicBase(saved.ANTHROPIC_BASE_URL);
    }
    const resolved = this.resolve(agentType, saved, registry);
    return this._effective(agentType, { ...saved, ...resolved });
  }

  /**
   * The saved env one agent runs on: the part of <type>.env it takes (see
   * typeEnvFor) under its own env, resolved. The daemon launches the agent on
   * this over its own environment, and readiness judges the agent on it too.
   * The agent's own env (daemon.yaml) is held to the same policy as the file.
   */
  getForAgent(agentType, registry, agentEnv) {
    const own = agentEnv ? this._effective(agentType, agentEnv, 'agent env') : agentEnv;
    const saved = { ...typeEnvFor(agentType, this.load(agentType), registry, own), ...(own || {}) };
    const resolved = this.resolve(agentType, saved, registry);
    return this._effective(agentType, { ...saved, ...resolved });
  }

  // -- internals --------------------------------------------------------------

  _file(agentType) {
    return path.join(this.envDir, `${agentType}.env`);
  }

  _warnOnce(id, message) {
    if (this._warned.has(id)) return;
    this._warned.add(id);
    try { this._warn(message); } catch {}
  }

  _effective(agentType, env, where = 'env') {
    return policy.sanitizeEnv(env, {
      onDrop: (key, reason) => this._warnOnce(
        `effective:${agentType}:${where}:${key}`,
        `${agentType}: left ${key} out of the agent's ${where} (${reason})`,
      ),
    });
  }

  _credentialStore() {
    if (!this._store) this._store = defaultCredentialStore(this.configDir);
    return this._store;
  }

  /** The store references are read from (also when new secrets stay in the file). */
  _readStore() {
    const s = this._credentialStore();
    return s && s.name !== 'none' ? s : null;
  }

  /** The store new secrets go to, or null to keep them in the protected file. */
  _writeStore() {
    const s = this._credentialStore();
    if (!s || s.writable === false) return null;
    try { return s.available() ? s : null; } catch { return null; }
  }

  /**
   * The file's entries, each held to the policy: a line that could not have
   * been saved (invalid name, runtime-control variable, a stray CR or NUL in
   * the value) is left out and reported by key name only.
   */
  _readRaw(agentType) {
    const file = this._file(agentType);
    let text;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    const entries = new Map();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (!key) continue;
      if (!policy.isValidKey(key)) {
        this._warnOnce(`line:${file}:${i}`, `${agentType}.env: ignoring line ${i + 1}, not a valid variable name`);
        continue;
      }
      const problem = policy.keyProblem(key) || policy.valueProblem(value, { allowReference: true });
      if (problem) {
        this._warnOnce(`drop:${file}:${key}`, `${agentType}.env: ignoring ${key} (${problem})`);
        continue;
      }
      entries.set(key, value);
    }
    return { text, entries };
  }

  _protectExisting(agentType) {
    try {
      fsProtect.protectDir(this.envDir, this._fsOptions);
      fsProtect.protectFile(this._file(agentType), this._fsOptions);
    } catch {}
  }

  _resolveReference(agentType, key, ref) {
    const store = this._readStore();
    if (!store) {
      this._warnOnce(`ref-nostore:${ref}`,
        `${agentType}: ${key} is kept in the OS credential store, which is not available; leaving it unset`);
      return null;
    }
    try {
      const value = store.get(policy.credentialIdOf(ref));
      if (value === null || value === undefined) {
        this._warnOnce(`ref-missing:${ref}`,
          `${agentType}: the OS credential store has no entry for ${key}; leaving it unset`);
        return null;
      }
      return value;
    } catch (err) {
      this._warnOnce(`ref-failed:${ref}`,
        `${agentType}: could not read ${key} from the OS credential store (${storeReason(err)}); leaving it unset`);
      return null;
    }
  }

  /** A reference's value, quietly: null when it cannot be read. */
  _peek(store, ref) {
    try { return store.get(policy.credentialIdOf(ref)); } catch { return null; }
  }

  /**
   * Put `value` in the store under a new reference and read it back. Returns
   * the reference only once the store has given back exactly that value;
   * otherwise the entry is removed again and the error thrown.
   */
  _storeSecret(store, agentType, key, value) {
    const ref = policy.newCredentialReference();
    const id = policy.credentialIdOf(ref);
    try {
      store.set(id, value, { label: `OpenAgents ${agentType} ${key}`, type: agentType, key });
      const back = store.get(id, { noCache: true });
      if (back !== value) {
        throw new CredentialStoreError('the stored value did not read back the same', 'CREDENTIAL_VERIFY_FAILED');
      }
      return ref;
    } catch (err) {
      this._deleteStored(store, ref);
      throw err;
    }
  }

  _deleteStored(store, ref) {
    if (!store) return;
    try { store.delete(policy.credentialIdOf(ref)); } catch {}
  }

  /** Whether any env file still refers to `ref` (a file copied by hand). */
  _refInUse(ref) {
    let names = [];
    try { names = fs.readdirSync(this.envDir); } catch { return false; }
    for (const name of names) {
      if (!name.endsWith('.env')) continue;
      try {
        if (fs.readFileSync(path.join(this.envDir, name), 'utf-8').includes(`=${ref}`)) return true;
      } catch {}
    }
    return false;
  }

  _noStoreNotice(agentType, key) {
    const s = this._credentialStore();
    if (!s || s.quiet || s.writable === false) return;
    this._warnOnce(`nostore:${agentType}:${key}`,
      `no OS credential store is available; ${key} for ${agentType} is kept in ${this._file(agentType)}, readable only by you`);
  }

  /**
   * Move plaintext secrets of an existing file to the store. Each one is
   * written and read back first; the file is rewritten only if it has not
   * changed since it was read (another process may be saving), and keeps the
   * working plaintext on any failure.
   */
  _migrate(agentType, raw, keys) {
    const store = this._writeStore();
    if (!store) return;
    const todo = keys.filter((k) => !this._migrationFailed.has(`${agentType}\0${k}`));
    if (!todo.length) return;
    this._withLock(agentType, { wait: false }, () => {
      const refs = new Map();
      for (const key of todo) {
        try {
          refs.set(key, this._storeSecret(store, agentType, key, raw.entries.get(key)));
        } catch (err) {
          this._migrationFailed.add(`${agentType}\0${key}`);
          this._warnOnce(`migrate:${agentType}:${key}`,
            `${agentType}: could not move ${key} to the OS credential store (${storeReason(err)}); it stays in the env file, readable only by you`);
        }
      }
      if (!refs.size) return;
      const entries = new Map(raw.entries);
      for (const [key, ref] of refs) entries.set(key, ref);
      let written = false;
      try { written = this._writeEntries(agentType, entries, { expectText: raw.text }); } catch {}
      if (!written) for (const ref of refs.values()) this._deleteStored(store, ref);
    });
  }

  _saveLocked(agentType, updates) {
    const raw = this._readRaw(agentType);
    const entries = new Map(raw ? raw.entries : []);
    const store = this._writeStore();
    const created = [];
    const obsolete = [];
    const updated = new Set(updates.map(([key]) => key));

    for (const [key, value] of updates) {
      const prev = entries.get(key);
      const prevRef = policy.isCredentialReference(prev) ? prev : null;
      if (value === null) {
        if (prev !== undefined) entries.delete(key);
        if (prevRef) obsolete.push(prevRef);
        continue;
      }
      if (policy.isSecretKey(key)) {
        if (store) {
          // Saved again unchanged (the launcher saves the whole env back).
          if (prevRef && this._peek(store, prevRef) === value) continue;
          try {
            const ref = this._storeSecret(store, agentType, key, value);
            created.push(ref);
            entries.set(key, ref);
            if (prevRef) obsolete.push(prevRef);
            continue;
          } catch (err) {
            this._warnOnce(`save:${agentType}:${key}`,
              `could not save ${key} for ${agentType} in the OS credential store (${storeReason(err)}); keeping it in the env file, readable only by you`);
          }
        } else {
          this._noStoreNotice(agentType, key);
        }
      }
      entries.set(key, value);
      if (prevRef) obsolete.push(prevRef);
    }

    // Plaintext secrets already in the file move too, as a load would move them.
    if (store) {
      for (const [key, value] of [...entries]) {
        if (updated.has(key) || !value || !policy.isSecretKey(key) || policy.isCredentialReference(value)) continue;
        if (this._migrationFailed.has(`${agentType}\0${key}`)) continue;
        try {
          const ref = this._storeSecret(store, agentType, key, value);
          created.push(ref);
          entries.set(key, ref);
        } catch (err) {
          this._migrationFailed.add(`${agentType}\0${key}`);
          this._warnOnce(`migrate:${agentType}:${key}`,
            `${agentType}: could not move ${key} to the OS credential store (${storeReason(err)}); it stays in the env file, readable only by you`);
        }
      }
    }

    try {
      this._writeEntries(agentType, entries);
    } catch (err) {
      for (const ref of created) this._deleteStored(store, ref);
      throw err;
    }
    const cleanup = store || this._readStore();
    for (const ref of obsolete) {
      if (!this._refInUse(ref)) this._deleteStored(cleanup, ref);
    }
  }

  /**
   * Write the entries as the file. With `expectText`, only if the file still
   * holds exactly that (returns false otherwise). Every line is checked once
   * more on the way out, so nothing that breaks the line format is written
   * whichever path produced it.
   */
  _writeEntries(agentType, entries, { expectText } = {}) {
    const file = this._file(agentType);
    const lines = [];
    for (const [key, value] of entries) {
      if (value === null || value === undefined || value === '') continue;
      policy.validateKey(key);
      policy.validateValue(key, value, { allowReference: true });
      lines.push(`${key}=${value}`);
    }
    if (expectText !== undefined) {
      let current = null;
      try { current = fs.readFileSync(file, 'utf-8'); } catch {}
      if (current !== expectText) return false;
    }
    fsProtect.ensurePrivateDir(this.envDir, this._fsOptions);
    fsProtect.writePrivateFile(file, lines.join('\n') + '\n', this._fsOptions);
    return true;
  }

  /**
   * Run `fn` holding <type>.env.lock, so a migration and a save (from the
   * daemon, a CLI child and the launcher at once) do not overwrite each
   * other. `wait: false` (migration) gives up at once when the lock is held;
   * `wait: true` (save) waits up to 2s, then goes ahead regardless.
   */
  _withLock(agentType, { wait }, fn) {
    const lock = `${this._file(agentType)}.lock`;
    const deadline = Date.now() + (wait ? 2000 : 0);
    let fd = null;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        fd = fs.openSync(lock, 'wx', 0o600);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') break;
        let stale = false;
        try { stale = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS; } catch {}
        if (stale) {
          try { fs.unlinkSync(lock); } catch {}
          continue;
        }
        if (Date.now() >= deadline) break;
        sleepMs(20);
      }
    }
    if (fd === null && !wait) return undefined;
    try {
      return fn();
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(lock); } catch {}
      }
    }
  }
}

/**
 * Set on an agent's own env when it signs in through its CLI (`codex login`,
 * `claude auth login`) instead of a key. Keys stay shared per type in
 * <type>.env and the launcher's own environment, and a CLI prefers a key it
 * is handed over its account session, so without this an agent created on
 * the sign-in tab still ran on whatever key was saved there earlier.
 */
const AUTH_MODE_KEY = 'OPENAGENTS_AUTH_MODE';
const CLI_LOGIN = 'cli_login';

/**
 * Whether the agent signs in through its CLI. Read from the agent's own env
 * only: a marker in <type>.env or the launcher's environment would otherwise
 * strip the key of every agent of that type, keyed ones included.
 */
function isCliLogin(agentEnv) {
  return !!agentEnv && agentEnv[AUTH_MODE_KEY] === CLI_LOGIN;
}

/**
 * Set on an agent's own env when its model is cleared from the workspace, so
 * it runs on its CLI's default. A cleared model used to be dropped from the
 * agent's env alone, and a model left in <type>.env (earlier versions saved
 * workspace models there) filled the gap again at the agent's next start. A
 * model in the agent's own env still wins; this only keeps the type's out.
 */
const MODEL_MODE_KEY = 'OPENAGENTS_MODEL_MODE';
const MODEL_DEFAULT = 'default';

function usesDefaultModel(agentEnv) {
  return !!agentEnv && agentEnv[MODEL_MODE_KEY] === MODEL_DEFAULT;
}

/**
 * Keys and endpoints a CLI reads under a name of its own that no registry
 * field or readiness check declares (the launcher's auth-specs.ts offers the
 * endpoints). Named per type rather than by suffix: the env stripped is the
 * daemon's whole environment, where *_BASE_URL also names endpoints that are
 * not the model's. CODEX_API_KEY: the Codex CLI honors it over its ChatGPT
 * sign-in, so one set system-wide would defeat the sign-in just as
 * OPENAI_API_KEY does.
 */
const NATIVE_CREDENTIALS = {
  codex: ['CODEX_API_KEY'],
  gemini: ['GOOGLE_GEMINI_BASE_URL'],
  antigravity: ['GOOGLE_GEMINI_BASE_URL'],
};

/**
 * The variables that carry a key or an endpoint for this agent type: its
 * password and *_BASE_URL fields, what LLM_API_KEY / LLM_BASE_URL resolve to,
 * and the *_API_KEY variables its readiness check accepts (Gemini has no
 * fields at all, and reads GEMINI_API_KEY / GOOGLE_API_KEY). Only the
 * *_API_KEY ones: that list also holds models and tokens other tools share
 * (MSWEA_MODEL_NAME, GH_TOKEN). The model is not among them, it applies to a
 * sign-in as well. So is
 * CLAUDE_CODE_OAUTH_TOKEN: `claude setup-token` makes it from the account
 * sign-in, so it is how a signed-in claude authenticates, not a key to drop.
 */
function credentialKeys(agentType, registry) {
  const keys = new Set(['LLM_API_KEY', 'LLM_BASE_URL', ...(NATIVE_CREDENTIALS[agentType] || [])]);
  if (!registry) return keys;
  for (const field of registry.getEnvFields?.(agentType) || []) {
    if (field.password || /BASE_URL$/.test(field.name || '')) keys.add(field.name);
  }
  for (const rule of registry.getResolveRules?.(agentType) || []) {
    if (keys.has(rule.from) && rule.to) keys.add(rule.to);
  }
  const checkReady = registry.getEntry?.(agentType)?.check_ready;
  for (const name of (checkReady && checkReady.env_vars) || []) {
    if (/_API_KEY$/.test(name)) keys.add(name);
  }
  return keys;
}

/**
 * The variables that pick the model: LLM_MODEL, what it resolves to
 * (CODEX_MODEL, ANTHROPIC_MODEL), and a type's own *_MODEL fields.
 */
function modelKeys(agentType, registry) {
  const keys = new Set(['LLM_MODEL']);
  if (!registry) return keys;
  for (const field of registry.getEnvFields?.(agentType) || []) {
    if (/_MODEL(_NAME)?$/.test(field.name || '')) keys.add(field.name);
  }
  for (const rule of registry.getResolveRules?.(agentType) || []) {
    if (rule.from === 'LLM_MODEL' && rule.to) keys.add(rule.to);
  }
  return keys;
}

/**
 * Whether the agent's own env carries a key (not just an endpoint).
 */
function hasOwnKey(agentType, registry, agentEnv) {
  if (!agentEnv) return false;
  for (const key of credentialKeys(agentType, registry)) {
    if (/BASE_URL$/.test(key)) continue;
    if (String(agentEnv[key] == null ? '' : agentEnv[key]).trim()) return true;
  }
  return false;
}

/**
 * The part of <type>.env an agent runs on. All of it for an agent that brings
 * no credentials of its own.
 *
 * A signed-in agent, or one with a key of its own, takes none of the type's
 * keys or endpoints, and none of its model either: that model was picked for
 * the type key's endpoint (a relay's openai-gpt-oss-20b), which neither the
 * account behind a sign-in nor the agent's own provider serves. Resolution
 * maps the generic LLM_* names over the provider ones, so a relay left in
 * <type>.env used to override an agent configured for DeepSeek: its
 * LLM_BASE_URL and LLM_MODEL became PI_BASE_URL and PI_MODEL, and the agent's
 * key went to the relay. An agent whose model was cleared (MODEL_MODE_KEY)
 * takes no model from it either. Its model is the one in its own env, else the
 * CLI's default.
 */
function typeEnvFor(agentType, typeEnv, registry, agentEnv) {
  const signedIn = isCliLogin(agentEnv);
  const ownKey = hasOwnKey(agentType, registry, agentEnv);
  if (!signedIn && !ownKey && !usesDefaultModel(agentEnv)) return typeEnv;
  const out = { ...typeEnv };
  if (signedIn || ownKey) {
    for (const key of credentialKeys(agentType, registry)) delete out[key];
  }
  for (const key of modelKeys(agentType, registry)) delete out[key];
  return out;
}

/**
 * `env` with every credential removed when the agent's own env (`agentEnv`)
 * marks a sign-in, or unchanged for an agent that runs on a key.
 */
function stripForCliLogin(agentType, env, registry, agentEnv) {
  if (!isCliLogin(agentEnv)) return env;
  const out = { ...env };
  for (const key of credentialKeys(agentType, registry)) delete out[key];
  return out;
}

/**
 * Anthropic's SDK appends the `/v1` segment itself: a base saved as
 * `https://relay.example/v1` makes the claude CLI call `…/v1/v1/messages`,
 * a 404 it mis-reports as "there's an issue with the selected model". The
 * launcher already strips the suffix for env saved through its UI
 * (env-normalize.ts); this is the same rule at the resolution layer, so env
 * written by ANY path — `agn env --set`, the workspace's remote
 * configure_agent command, a hand-edited file — is covered too. OpenAI-style
 * bases legitimately carry `/v1` and are left alone.
 */
function normalizeAnthropicBase(url) {
  return String(url || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

module.exports = {
  EnvManager, EnvValidationError, AUTH_MODE_KEY, CLI_LOGIN, MODEL_MODE_KEY, MODEL_DEFAULT, isCliLogin, credentialKeys,
  modelKeys, stripForCliLogin, typeEnvFor,
};
