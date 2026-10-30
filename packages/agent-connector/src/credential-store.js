'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const fsProtect = require('./fs-protect');

/**
 * The OS credential store, behind one small synchronous interface:
 *
 *   store.name                       'keychain' | 'secret-service' | 'dpapi' | 'none'
 *   store.available()                whether it can be used on this machine now
 *   store.set(id, secret, { label }) save (throws CredentialStoreError)
 *   store.get(id, { noCache })       the secret, or null when there is no entry
 *   store.delete(id)                 remove (no error when already gone)
 *
 * `id` is the 32-hex-digit id of a credential reference (env-policy.js).
 * Synchronous because env loading is (EnvManager#load is called all over the
 * daemon and CLI). Lookups are cached per process; entries never change under
 * an id, so the cache cannot go stale.
 *
 * The secret never appears in a child process's arguments, which any local
 * user can read from `ps`:
 *  - macOS: /usr/bin/security driven through `security -i`, the command on
 *    stdin, the secret hex-encoded inside it (-X). Lookups and deletes carry
 *    only the id and service name in argv.
 *  - Linux: `secret-tool store|lookup|clear` (libsecret / Secret Service over
 *    D-Bus), the secret on stdin.
 *  - Windows: DPAPI (CurrentUser) through Windows PowerShell's
 *    ConvertFrom-SecureString, the secret base64-encoded on stdin, the script
 *    passed as -EncodedCommand. The encrypted blob lives in
 *    <configDir>/credentials/<id>.dpapi with a user-only ACL.
 *
 * Error messages describe what failed, never what was being stored: neither
 * the secret nor a child's raw output (which could echo it) is included.
 */

const SERVICE = 'openagents-launcher';
const ID_PATTERN = /^[0-9a-f]{32}$/;
const TIMEOUT_MS = 15000;
/** A store that just failed is not asked again for this long. */
const FAILURE_TTL_MS = 30000;
/** Marks a keychain value we base64-encoded (see encodeForKeychain). */
const B64_MARKER = 'oa-b64:';
/**
 * `security -i` reads each command line into a 4 KiB buffer (4058 bytes passed
 * whole, 4108 did not, macOS 26). A longer line is not refused: it is cut, the
 * first part RUNS (an add with its trailing arguments gone, so into the
 * default keychain with truncated data) and the rest is read as a second
 * command. Lines are kept well below that.
 */
const MAX_SECURITY_LINE = 3000;

class CredentialStoreError extends Error {
  constructor(message, code = 'CREDENTIAL_STORE_FAILED') {
    super(message);
    this.name = 'CredentialStoreError';
    this.code = code;
  }
}

function checkId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new CredentialStoreError('invalid credential id', 'CREDENTIAL_ID_INVALID');
  }
}

/** Label text safe inside a double-quoted `security -i` argument and argv. */
function safeLabel(label) {
  return String(label || 'OpenAgents credential').replace(/[^A-Za-z0-9 ._:/@-]/g, '_').slice(0, 120);
}

function stripTrailingNewline(text) {
  return String(text || '').replace(/\r?\n$/, '');
}

/** A short, value-free reason for a failed child process. */
function failureReason(r) {
  if (r.error) {
    if (r.error.code === 'ENOENT') return 'the credential tool is not installed';
    if (r.error.code === 'ETIMEDOUT') return 'the credential tool did not answer in time';
    return `the credential tool could not run (${r.error.code || 'error'})`;
  }
  const stderr = String(r.stderr || '');
  if (/interaction is not allowed|user interaction/i.test(stderr)) return 'the keychain is locked';
  if (/d-?bus|org\.freedesktop\.secrets|secret service/i.test(stderr)) return 'no Secret Service is reachable';
  if (r.signal) return `the credential tool was stopped (${r.signal})`;
  return `the credential tool exited with status ${r.status}`;
}

function failed(r) {
  return !!r.error || r.status !== 0;
}

class BaseStore {
  constructor(opts = {}) {
    this._spawnSync = opts.spawnSync || childProcess.spawnSync;
    this._now = opts.now || Date.now;
    this._cache = new Map();
    this._failures = new Map();
    this.writable = opts.writable !== false;
    this.quiet = !!opts.quiet;
  }

  get(id, { noCache = false } = {}) {
    checkId(id);
    if (!noCache) {
      if (this._cache.has(id)) return this._cache.get(id);
      const f = this._failures.get(id);
      if (f && this._now() - f.at < FAILURE_TTL_MS) throw f.err;
    }
    try {
      const value = this._get(id);
      this._failures.delete(id);
      if (value !== null) this._cache.set(id, value);
      return value;
    } catch (err) {
      const e = err instanceof CredentialStoreError ? err : new CredentialStoreError(`${this.name} lookup failed`);
      this._failures.set(id, { at: this._now(), err: e });
      throw e;
    }
  }

  set(id, secret, meta = {}) {
    checkId(id);
    if (typeof secret !== 'string' || secret === '') {
      throw new CredentialStoreError('a credential must be a non-empty string', 'CREDENTIAL_INVALID');
    }
    this._cache.delete(id);
    this._failures.delete(id);
    this._set(id, secret, meta);
  }

  delete(id) {
    checkId(id);
    this._cache.delete(id);
    this._failures.delete(id);
    this._delete(id);
  }

  _run(cmd, args, input) {
    return this._spawnSync(cmd, args, {
      input: input === undefined ? '' : input,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}

// -- macOS Keychain ----------------------------------------------------------

/**
 * `security find-generic-password -w` prints a password that is not printable
 * ASCII as hex, with nothing to tell the two apart. Values that are printable
 * ASCII (every API key we know of) are stored as they are, readable in
 * Keychain Access; anything else, or anything that happens to start with the
 * marker, is stored as marker + base64.
 */
function encodeForKeychain(secret) {
  if (/^[\x20-\x7e]*$/.test(secret) && !secret.startsWith(B64_MARKER)) return secret;
  return B64_MARKER + Buffer.from(secret, 'utf8').toString('base64');
}

function decodeFromKeychain(text) {
  if (text.startsWith(B64_MARKER)) return Buffer.from(text.slice(B64_MARKER.length), 'base64').toString('utf8');
  return text;
}

class MacKeychainStore extends BaseStore {
  constructor(opts = {}) {
    super(opts);
    this.name = 'keychain';
    this._bin = opts.securityPath || '/usr/bin/security';
    this._exists = opts.exists || fs.existsSync;
    // An explicit keychain file instead of the default one (manual testing).
    this._keychain = opts.keychain || null;
    if (this._keychain && /["\\\r\n\0]/.test(this._keychain)) {
      throw new CredentialStoreError('invalid keychain path', 'CREDENTIAL_STORE_CONFIG');
    }
  }

  available() {
    try { return !!this._exists(this._bin); } catch { return false; }
  }

  _set(id, secret, meta) {
    const hex = Buffer.from(encodeForKeychain(secret), 'utf8').toString('hex');
    const parts = [
      'add-generic-password', '-U',
      '-a', `"${id}"`,
      '-s', `"${SERVICE}"`,
      '-l', `"${safeLabel(meta.label)}"`,
      '-X', hex,
    ];
    if (this._keychain) parts.push(`"${this._keychain}"`);
    const line = `${parts.join(' ')}\n`;
    // Never let `security -i` cut the line (see MAX_SECURITY_LINE): a value
    // this long (over ~1.4 KB) stays in the protected env file instead.
    if (Buffer.byteLength(line) > MAX_SECURITY_LINE) {
      throw new CredentialStoreError('value is too long for the keychain command line', 'CREDENTIAL_TOO_LONG');
    }
    // The command (and with it the secret) goes over stdin, not argv.
    const r = this._run(this._bin, ['-i'], line);
    if (failed(r)) throw new CredentialStoreError(`keychain write failed: ${failureReason(r)}`);
  }

  _get(id) {
    const args = ['find-generic-password', '-a', id, '-s', SERVICE, '-w'];
    if (this._keychain) args.push(this._keychain);
    const r = this._run(this._bin, args, '');
    if (!r.error && r.status === 44) return null; // errSecItemNotFound
    if (failed(r)) throw new CredentialStoreError(`keychain lookup failed: ${failureReason(r)}`);
    return decodeFromKeychain(stripTrailingNewline(r.stdout));
  }

  _delete(id) {
    const args = ['delete-generic-password', '-a', id, '-s', SERVICE];
    if (this._keychain) args.push(this._keychain);
    const r = this._run(this._bin, args, '');
    if (!r.error && (r.status === 0 || r.status === 44)) return;
    throw new CredentialStoreError(`keychain delete failed: ${failureReason(r)}`);
  }
}

// -- Linux Secret Service (libsecret's secret-tool) --------------------------

function findOnPath(name, envPath, exists = fs.existsSync) {
  for (const dir of String(envPath || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try { if (exists(candidate)) return candidate; } catch {}
  }
  return null;
}

class SecretServiceStore extends BaseStore {
  constructor(opts = {}) {
    super(opts);
    this.name = 'secret-service';
    this._env = opts.env || process.env;
    this._exists = opts.exists || fs.existsSync;
    this._bin = opts.secretToolPath !== undefined
      ? opts.secretToolPath
      : findOnPath('secret-tool', this._env.PATH, this._exists);
  }

  /**
   * secret-tool installed and a session bus to reach the Secret Service on.
   * A headless box (SSH, a server without a desktop session) has neither, and
   * the env file is kept instead.
   */
  available() {
    if (!this._bin) return false;
    if (this._env.DBUS_SESSION_BUS_ADDRESS) return true;
    const runtime = this._env.XDG_RUNTIME_DIR;
    try { return !!runtime && !!this._exists(path.join(runtime, 'bus')); } catch { return false; }
  }

  _set(id, secret, meta) {
    const r = this._run(this._bin, [
      'store', `--label=${safeLabel(meta.label)}`, 'service', SERVICE, 'account', id,
    ], secret);
    if (failed(r)) throw new CredentialStoreError(`secret service write failed: ${failureReason(r)}`);
  }

  _get(id) {
    const r = this._run(this._bin, ['lookup', 'service', SERVICE, 'account', id], '');
    // Not found: exit 1 and nothing said.
    if (!r.error && r.status === 1 && !String(r.stderr || '').trim()) return null;
    if (failed(r)) throw new CredentialStoreError(`secret service lookup failed: ${failureReason(r)}`);
    return stripTrailingNewline(r.stdout);
  }

  _delete(id) {
    const r = this._run(this._bin, ['clear', 'service', SERVICE, 'account', id], '');
    if (!r.error && (r.status === 0 || (r.status === 1 && !String(r.stderr || '').trim()))) return;
    throw new CredentialStoreError(`secret service delete failed: ${failureReason(r)}`);
  }
}

// -- Windows DPAPI -----------------------------------------------------------

const PS_PROTECT = [
  "$ErrorActionPreference = 'Stop'",
  '$in = [Console]::In.ReadToEnd().Trim()',
  '$plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($in))',
  '$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force',
  '[Console]::Out.Write((ConvertFrom-SecureString -SecureString $secure))',
].join('\n');

const PS_UNPROTECT = [
  "$ErrorActionPreference = 'Stop'",
  '$blob = [Console]::In.ReadToEnd().Trim()',
  '$secure = ConvertTo-SecureString -String $blob',
  '$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
  'try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }',
  'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }',
  '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain)))',
].join('\n');

function powershellArgs(script) {
  return [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ];
}

function powershellPath(env) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

class WindowsDpapiStore extends BaseStore {
  constructor(opts = {}) {
    super(opts);
    this.name = 'dpapi';
    this._env = opts.env || process.env;
    this._exists = opts.exists || fs.existsSync;
    this._ps = opts.powershellPath || powershellPath(this._env);
    if (!opts.configDir) throw new CredentialStoreError('configDir is required', 'CREDENTIAL_STORE_CONFIG');
    this._dir = path.join(opts.configDir, 'credentials');
    this._fsOptions = { platform: 'win32', execFileSync: opts.execFileSync, env: this._env, warn: opts.warn };
  }

  available() {
    try { return !!this._exists(this._ps); } catch { return false; }
  }

  _blobFile(id) {
    return path.join(this._dir, `${id}.dpapi`);
  }

  _set(id, secret) {
    const input = Buffer.from(secret, 'utf8').toString('base64');
    const r = this._run(this._ps, powershellArgs(PS_PROTECT), input);
    if (failed(r)) throw new CredentialStoreError(`DPAPI protect failed: ${failureReason(r)}`);
    const blob = String(r.stdout || '').trim();
    if (!/^[0-9A-Fa-f]+$/.test(blob)) throw new CredentialStoreError('DPAPI protect returned no data');
    fsProtect.ensurePrivateDir(this._dir, this._fsOptions);
    fsProtect.writePrivateFile(this._blobFile(id), `${blob}\n`, this._fsOptions);
  }

  _get(id) {
    let blob;
    try {
      blob = fs.readFileSync(this._blobFile(id), 'utf-8').trim();
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new CredentialStoreError('DPAPI blob could not be read');
    }
    const r = this._run(this._ps, powershellArgs(PS_UNPROTECT), blob);
    if (failed(r)) throw new CredentialStoreError(`DPAPI unprotect failed: ${failureReason(r)}`);
    return Buffer.from(String(r.stdout || '').trim(), 'base64').toString('utf8');
  }

  _delete(id) {
    try { fs.unlinkSync(this._blobFile(id)); } catch (err) {
      if (err.code !== 'ENOENT') throw new CredentialStoreError('DPAPI blob could not be removed');
    }
  }
}

// -- No store ----------------------------------------------------------------

class NoStore {
  constructor(opts = {}) {
    this.name = 'none';
    this.writable = false;
    this.quiet = !!opts.quiet;
  }
  available() { return false; }
  get() { throw new CredentialStoreError('no credential store is configured', 'CREDENTIAL_STORE_UNAVAILABLE'); }
  set() { throw new CredentialStoreError('no credential store is configured', 'CREDENTIAL_STORE_UNAVAILABLE'); }
  delete() {}
}

// -- Selection ---------------------------------------------------------------

const MODES = new Set(['auto', 'keychain', 'secret-service', 'dpapi', 'file', 'off']);

function platformBackend(platform) {
  if (platform === 'darwin') return 'keychain';
  if (platform === 'win32') return 'dpapi';
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return 'secret-service';
  return null;
}

/**
 * Test runners never get the real OS store implicitly: a suite saving dummy
 * keys must not write them into the developer's login keychain.
 */
function underTestRunner(env) {
  return !!(env.NODE_TEST_CONTEXT || env.VITEST || env.JEST_WORKER_ID) || env.NODE_ENV === 'test';
}

/**
 * OPENAGENTS_CREDENTIAL_STORE:
 *   auto (default)  the platform's store; the protected env file when it is unavailable
 *   keychain | secret-service | dpapi   that store
 *   file            keep new secrets in the protected env file; references
 *                   already saved are still read from the platform's store
 *   off             no store at all (default under a test runner)
 */
function resolveMode(env) {
  const raw = String(env.OPENAGENTS_CREDENTIAL_STORE || '').trim().toLowerCase();
  if (raw) return MODES.has(raw) ? raw : 'auto';
  return underTestRunner(env) ? 'off' : 'auto';
}

function createBackend(name, opts) {
  if (name === 'keychain') return new MacKeychainStore(opts);
  if (name === 'secret-service') return new SecretServiceStore(opts);
  if (name === 'dpapi') return new WindowsDpapiStore(opts);
  return new NoStore(opts);
}

/**
 * The store for this machine, as OPENAGENTS_CREDENTIAL_STORE selects it.
 * opts: { configDir, platform, env, spawnSync, execFileSync, exists }.
 */
function createCredentialStore(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const mode = opts.mode || resolveMode(env);
  if (mode === 'off') return new NoStore({ quiet: true });
  const name = mode === 'auto' || mode === 'file' ? platformBackend(platform) : mode;
  if (!name) return new NoStore({ quiet: mode === 'file' });
  try {
    return createBackend(name, { ...opts, env, writable: mode !== 'file', quiet: mode === 'file' });
  } catch {
    return new NoStore({ quiet: false });
  }
}

const defaults = new Map();

/** One store per config directory per process, so the lookup cache is shared. */
function defaultCredentialStore(configDir) {
  const key = path.resolve(configDir || '.');
  if (!defaults.has(key)) defaults.set(key, createCredentialStore({ configDir: key }));
  return defaults.get(key);
}

module.exports = {
  SERVICE,
  CredentialStoreError,
  MacKeychainStore,
  SecretServiceStore,
  WindowsDpapiStore,
  NoStore,
  createCredentialStore,
  defaultCredentialStore,
  resolveMode,
  underTestRunner,
  encodeForKeychain,
  decodeFromKeychain,
  powershellArgs,
  PS_PROTECT,
  PS_UNPROTECT,
};
