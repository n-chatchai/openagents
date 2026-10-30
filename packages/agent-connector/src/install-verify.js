'use strict';

/**
 * Which installs this launcher can verify before it runs them, and the check.
 *
 * Trust model:
 *   - An npm runtime is verifiable when its registry entry pins an exact
 *     version and that version's sha512 integrity (install.npm_package,
 *     install.npm_version, install.npm_integrity — recorded from the npm
 *     registry when the pin was made, and shipped with this launcher). The
 *     installer downloads that tarball, hashes it itself and installs that
 *     exact file; a mismatch is refused, and nothing is installed. What the
 *     check covers is the package's own tarball: its dependencies are resolved
 *     by npm from the registry, and whatever its install script downloads is
 *     the vendor's to secure.
 *   - Everything else — a vendor's `curl … | sh` or PowerShell script, pip,
 *     uv, an npm command with no pin, the portable Node.js bootstrap — cannot
 *     be verified here. It runs only when a person on this computer asks for
 *     it (`agn install <type> --allow-unverified`, or the launcher's own
 *     Install button), never under the daemon (OPENAGENTS_UNATTENDED=1, which
 *     every `agn` child the daemon runs carries — so no remote command can).
 *   - api_only entries install nothing: always allowed.
 *   - Pins count only from the catalog shipped inside this package
 *     (registry.json), which has the code's own trust. The catalog the
 *     launcher also fetches from the workspace server can add agent types;
 *     what they install is never "verified", whatever pin they carry.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Set by the daemon on every `agn` child it runs: no person is at the keyboard. */
const UNATTENDED_ENV = 'OPENAGENTS_UNATTENDED';

function isUnattended(env = process.env) {
  const v = String((env && env[UNATTENDED_ENV]) || '').trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
}

/** `npm install [-g] <pkg>[@<spec>]` → { pkg, spec }, or null for anything else. */
const NPM_INSTALL_RE = /^npm\s+(?:install|i)\s+(?:-g\s+)?(@?[\w.-]+(?:\/[\w.-]+)?)(?:@(\S+))?\s*$/;

function parseNpmInstall(cmd) {
  const m = NPM_INSTALL_RE.exec(String(cmd || '').trim());
  return m ? { pkg: m[1], spec: m[2] || null } : null;
}

/** A single sha512 Subresource Integrity value, the form npm publishes. */
const SHA512_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;

function isSha512Integrity(value) {
  return typeof value === 'string' && SHA512_RE.test(value.trim());
}

/** `sha512-<base64>` of a file, read in chunks (runtime tarballs run to tens of MB). */
function integrityOfFile(file) {
  const hash = crypto.createHash('sha512');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return `sha512-${hash.digest('base64')}`;
}

/**
 * Whether `file` is what `expected` (an SRI string, possibly several
 * space-separated hashes) says. Only sha512 counts: a pin without one
 * verifies nothing.
 */
function verifyFileIntegrity(file, expected) {
  const actual = integrityOfFile(file);
  const wanted = String(expected || '').trim().split(/\s+/).filter(isSha512Integrity);
  return { ok: wanted.length > 0 && wanted.includes(actual), actual };
}

let shipped = null;

/** The catalog shipped inside this package: the only source of trusted pins. */
function shippedCatalog() {
  if (!shipped) {
    try {
      shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'registry.json'), 'utf-8'));
    } catch {
      shipped = [];
    }
    if (!Array.isArray(shipped)) shipped = [];
  }
  return shipped;
}

/** The shipped catalog's entry for `name`, or null for a type only a server listed. */
function shippedEntry(name) {
  return shippedCatalog().find((e) => e && e.name === name) || null;
}

function platformKey(platform = process.platform) {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

/**
 * How an entry installs on this platform, and whether that can be verified:
 *   { kind: 'api_only', verified: true }
 *   { kind: 'npm', verified: true, pkg, version, integrity, command }
 *   { kind: 'npm' | 'script' | 'manual' | 'none', verified: false, command, reason }
 * `command` is what a person can run themselves. An npm route is verified
 * only when the entry's pin is the one the shipped catalog has for that type
 * (`opts.shipped`, that type's shipped install, overrides the lookup for
 * tests): a type only a server listed, or a pin that differs, is not.
 */
function installRoute(entry, plat = platformKey(), opts = {}) {
  const install = entry && entry.install;
  if (!install) return { kind: 'none', verified: false, command: null, reason: 'no install definition' };
  if (install.api_only) return { kind: 'api_only', verified: true, command: null };
  const command = install[plat] || install.command || install.npm || null;
  if (!command) return { kind: 'none', verified: false, command: null, reason: `no install command for ${plat}` };
  if (/^echo\s/.test(command.trim())) return { kind: 'manual', verified: false, command, reason: 'set up by hand' };
  const npm = parseNpmInstall(command);
  if (!npm) return { kind: 'script', verified: false, command, reason: 'a script this launcher cannot check' };
  const pkg = install.npm_package || npm.pkg;
  const version = install.npm_version;
  const integrity = install.npm_integrity;
  if (pkg !== npm.pkg || !version || !isSha512Integrity(integrity)) {
    return { kind: 'npm', verified: false, command, reason: 'no pinned version and checksum' };
  }
  const trusted = opts.shipped !== undefined
    ? opts.shipped
    : ((shippedEntry(entry.name) || {}).install || null);
  if (!trusted || (trusted.npm_package || pkg) !== pkg || trusted.npm_version !== version || trusted.npm_integrity !== integrity) {
    return { kind: 'npm', verified: false, command, reason: 'its pin is not the one shipped with this launcher' };
  }
  return { kind: 'npm', verified: true, pkg, version, integrity, command: `npm install -g ${pkg}@${version}` };
}

/** Raised when an install would have to run something it cannot verify. */
class UnverifiedInstallError extends Error {
  constructor(message, route) {
    super(message);
    this.name = 'UnverifiedInstallError';
    this.code = 'INSTALL_UNVERIFIED';
    this.route = route || null;
  }
}

/** Raised when a downloaded artifact does not match its pin. */
class IntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IntegrityError';
    this.code = 'INSTALL_INTEGRITY';
  }
}

/** What a refused unverified install tells the person: what to run instead. */
function unverifiedMessage(type, entry, route) {
  const label = (entry && entry.label) || type;
  if (route && route.kind === 'manual') {
    return `${label} has no automatic install. Set it up on this computer: ${String(route.command).replace(/^echo\s+/, '').replace(/^['"]|['"]$/g, '')}`;
  }
  const what = route && route.kind === 'npm'
    ? 'an npm package with no pinned version and checksum'
    : "its vendor's install script";
  const lines = [`${label} installs from ${what}, which OpenAgents cannot verify before running it.`];
  if (isUnattended()) {
    lines.push('It is not run for a remote or unattended request. On this computer, run:');
  } else {
    lines.push('To run it anyway, on this computer:');
  }
  lines.push(`  agn install ${type} --allow-unverified`);
  if (route && route.command) {
    lines.push('Or install it yourself:');
    lines.push(`  ${route.command}`);
  }
  return lines.join('\n');
}

module.exports = {
  UNATTENDED_ENV,
  isUnattended,
  parseNpmInstall,
  isSha512Integrity,
  integrityOfFile,
  verifyFileIntegrity,
  installRoute,
  shippedEntry,
  platformKey,
  unverifiedMessage,
  UnverifiedInstallError,
  IntegrityError,
};
