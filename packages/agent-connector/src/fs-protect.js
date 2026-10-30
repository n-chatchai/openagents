'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

/**
 * Files only the current user may read: the env files that hold API keys and
 * daemon.yaml, which holds workspace tokens. Both used to be written with the
 * default mode (0644 under the usual umask), readable by every account on the
 * machine.
 *
 * POSIX: directories 0700, files 0600 — set when the file is created (never a
 * moment at the default mode) and re-applied to files an older version left
 * behind. Windows: chmod cannot express this, so the ACL is replaced with one
 * that grants the current user alone (icacls /inheritance:r /grant:r).
 *
 * Every function takes an optional `opts` of { platform, execFileSync, env,
 * warn } so the Windows path can be exercised on any machine.
 */

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// Paths whose Windows ACL this process already set (icacls costs a process).
const aclDone = new Set();
const warned = new Set();

function settings(opts = {}) {
  return {
    platform: opts.platform || process.platform,
    execFileSync: opts.execFileSync || childProcess.execFileSync,
    env: opts.env || process.env,
    warn: opts.warn || defaultWarn,
  };
}

function defaultWarn(message) {
  try { process.stderr.write(`[openagents] ${message}\n`); } catch {}
}

function warnOnce(s, id, message) {
  if (warned.has(id)) return;
  warned.add(id);
  s.warn(message);
}

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

/** `DOMAIN\user` for the account running this process. */
function windowsAccount(env) {
  let user = env.USERNAME;
  if (!user) {
    try { user = os.userInfo().username; } catch {}
  }
  if (!user) return null;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
}

function icaclsPath(env) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'icacls.exe');
}

/**
 * Replace the ACL on `target` with one entry: full control for the current
 * user. Directories grant it inheritably, so files created inside start out
 * the same way. The command line carries only the path and the account.
 */
function restrictWindowsAcl(target, opts = {}) {
  const s = settings(opts);
  const account = windowsAccount(s.env);
  if (!account) throw new Error('could not determine the current Windows account');
  const grant = opts.isDir ? `${account}:(OI)(CI)F` : `${account}:F`;
  s.execFileSync(icaclsPath(s.env), [target, '/inheritance:r', '/grant:r', grant, '/Q'], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 15000,
  });
}

function applyWindowsAcl(target, s, opts, { once }) {
  const id = `${opts.isDir ? 'd' : 'f'}:${path.resolve(target)}`;
  if (once && aclDone.has(id)) return;
  try {
    restrictWindowsAcl(target, { ...opts, platform: s.platform, execFileSync: s.execFileSync, env: s.env });
    aclDone.add(id);
  } catch {
    warnOnce(s, `acl:${id}`, `could not restrict access to ${target} to the current user (icacls failed)`);
  }
}

function chmodIfNeeded(target, mode) {
  try {
    const st = fs.statSync(target);
    if ((st.mode & 0o777) !== mode) fs.chmodSync(target, mode);
  } catch {}
}

/** Create `dir` (and parents) if needed and make it private. */
function ensurePrivateDir(dir, opts = {}) {
  const s = settings(opts);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if (s.platform === 'win32') applyWindowsAcl(dir, s, { ...opts, isDir: true }, { once: true });
  else chmodIfNeeded(dir, DIR_MODE);
}

/**
 * Narrow an existing directory or file an older version left readable, on the
 * read path (no-op when it does not exist). POSIX only: a stat and, at most
 * once, a chmod. On Windows checking an ACL costs a process, which every CLI
 * child reading its env would pay; there the ACL is set when the file is next
 * written (ensurePrivateDir / writePrivateFile), which for env files is the
 * first load that moves their secrets to the credential store.
 */
function protectDir(dir, opts = {}) {
  const s = settings(opts);
  if (s.platform === 'win32') return;
  if (fs.existsSync(dir)) chmodIfNeeded(dir, DIR_MODE);
}

function protectFile(file, opts = {}) {
  const s = settings(opts);
  if (s.platform === 'win32') return;
  if (fs.existsSync(file)) chmodIfNeeded(file, FILE_MODE);
}

function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off, off);
}

/**
 * Rewrite `file` in place, keeping its inode (a watcher on the path keeps
 * working) but never its old permissions: the mode is narrowed before the new
 * content goes in.
 */
function writeInPlace(file, buf, s, opts) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT, FILE_MODE);
  try {
    if (s.platform !== 'win32') fs.fchmodSync(fd, FILE_MODE);
    fs.ftruncateSync(fd, 0);
    writeAll(fd, buf);
  } finally {
    fs.closeSync(fd);
  }
  if (s.platform === 'win32') applyWindowsAcl(file, s, { ...opts, isDir: false }, { once: true });
}

function renameWithRetry(from, to, s) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return true;
    } catch (err) {
      // Windows refuses to replace a file another process holds open.
      const busy = s.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(err.code);
      if (!busy) throw err;
      if (attempt >= 5) return false;
      sleepMs(20 * (attempt + 1));
    }
  }
}

/**
 * Write `data` to `file` readable by the current user only.
 *
 * Atomic by default: the content goes to a temp file in the same directory,
 * created 0600 (and, on Windows, given the private ACL) before a byte is
 * written, fsynced, then renamed over `file`. A reader sees the old file or
 * the new one, never half of either. `{ atomic: false }` rewrites in place
 * instead, for a file something watches by inode (daemon.yaml).
 */
function writePrivateFile(file, data, opts = {}) {
  const s = settings(opts);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8');
  if (opts.atomic === false) return writeInPlace(file, buf, s, opts);

  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', FILE_MODE);
    if (s.platform !== 'win32') fs.fchmodSync(fd, FILE_MODE);
    writeAll(fd, buf);
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd);
    fd = null;
    if (s.platform === 'win32') applyWindowsAcl(tmp, s, { ...opts, isDir: false }, { once: false });
    if (!renameWithRetry(tmp, file, s)) {
      // Still held open elsewhere: fall back to rewriting it in place.
      writeInPlace(file, buf, s, opts);
      try { fs.unlinkSync(tmp); } catch {}
    }
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

module.exports = {
  FILE_MODE,
  DIR_MODE,
  ensurePrivateDir,
  protectDir,
  protectFile,
  writePrivateFile,
  restrictWindowsAcl,
  windowsAccount,
  icaclsPath,
  _resetForTests() { aclDone.clear(); warned.clear(); },
};
