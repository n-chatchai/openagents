'use strict';

const crypto = require('crypto');

/**
 * What an agent's saved environment may hold, and what may reach the
 * environment an agent is launched with.
 *
 * Saved env comes from several places a person does not type into directly:
 * the workspace's remote configure_agent / create_agent commands, the
 * launcher UI, library callers. They all end in two stores: the line-based
 * ~/.openagents/env/<type>.env files (env.js) and the per-agent `env:` maps in
 * ~/.openagents/daemon.yaml (config.js). The rules here are applied where
 * those are written AND where they are read back, so a value that slipped in
 * through an older version (or a hand edit) is still refused at launch.
 *
 * - A key is a plain variable name. Anything else cannot be an env var and in
 *   the line format can smuggle in a second assignment.
 * - A value must survive the `KEY=VALUE` line format unchanged: no CR, LF or
 *   NUL (a line break starts a new variable, `LLM_API_KEY="x\nNODE_OPTIONS=…"`),
 *   a string, and of a sane size.
 * - Runtime-control variables (BLOCKED_KEYS / BLOCKED_PREFIXES) are never
 *   taken from saved env at all: they make the agent's runtime load code,
 *   trust other certificates, route through another proxy or resolve other
 *   binaries. An agent that genuinely needs one inherits it from the
 *   launcher's own environment, which a workspace cannot write.
 *
 * Errors name the key and the reason, never the value: values are API keys.
 */

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_VALUE_LENGTH = 32 * 1024;

/** Names that are valid identifiers but mean something to a JS object. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * An agent type names a file, `<type>.env`: one path segment, no `..`. The
 * type comes from workspace commands too (configure_agent's args.type), and
 * `../../project/` would otherwise have written `~/project/.env`.
 */
const AGENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Keys whose values are credentials. Those go to the OS credential store
 * (credential-store.js) and the env file keeps a reference. The suffixes
 * cover access/secret key pairs the registry marks as passwords
 * (CODEARTS_CLI_AK / CODEARTS_CLI_SK).
 */
const SECRET_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
const SECRET_SUFFIX_PATTERN = /_(AK|SK)$/i;

/**
 * What an env file holds in place of a secret: `LLM_API_KEY=@credential:<id>`.
 * The id is random (not derived from type/key), so every saved value is a new
 * immutable store entry: a cached lookup can never be stale, and two config
 * directories on one machine never collide.
 */
const CREDENTIAL_REF_PREFIX = '@credential:';
const CREDENTIAL_REF_PATTERN = /^@credential:[0-9a-f]{32}$/;

/**
 * Runtime-control variables. Compared case-insensitively: Windows env names
 * are case-insensitive (`Path` is PATH) and most tools read proxies in lower
 * case too.
 */
const BLOCKED_KEYS = new Set([
  // Node / Electron
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_REPL_EXTERNAL_MODULE', 'ELECTRON_RUN_AS_NODE',
  // Python
  'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONINSPECT', 'PYTHONUSERBASE',
  'PYTHONWARNINGS', 'PYTHONHTTPSVERIFY',
  // Perl / Ruby / Java
  'PERL5OPT', 'PERL5LIB', 'PERLLIB', 'RUBYOPT', 'RUBYLIB',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH',
  // Shells
  'BASH_ENV', 'ENV', 'ZDOTDIR', 'PROMPT_COMMAND', 'SHELLOPTS', 'BASHOPTS', 'IFS', 'PS4',
  // Where binaries, config and shells come from
  'PATH', 'HOME', 'SHELL', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
  'COMSPEC', 'PATHEXT', 'PSMODULEPATH',
  // Programs other tools run on our behalf
  'EDITOR', 'VISUAL', 'PAGER', 'BROWSER', 'SSH_ASKPASS', 'SUDO_ASKPASS',
  // Git
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH', 'GIT_ASKPASS', 'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR', 'GIT_PAGER', 'GIT_PROXY_COMMAND', 'GIT_EXTERNAL_DIFF',
  'GIT_SSL_NO_VERIFY', 'GIT_SSL_CAINFO', 'GIT_TEMPLATE_DIR',
  // Certificates
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
  // Proxies
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY',
]);

/** Families blocked by prefix: the dynamic linkers, git config injection, npm config. */
const BLOCKED_PREFIXES = ['LD_', 'DYLD_', 'GIT_CONFIG', 'NPM_CONFIG_'];

class EnvValidationError extends Error {
  /**
   * @param {string} subject what was refused, already safe to print
   * @param {string} reason why
   */
  constructor(subject, reason) {
    super(`Refused ${subject}: ${reason}`);
    this.name = 'EnvValidationError';
    this.code = 'ENV_INVALID';
    this.subject = subject;
    this.reason = reason;
  }
}

/**
 * A name as it may appear in a message: a valid key as is, anything else
 * quoted (so a line break in it cannot forge a log line) and cut short.
 */
function describeName(name) {
  if (typeof name === 'string' && KEY_PATTERN.test(name)) return name;
  const text = typeof name === 'string' ? name : String(name);
  const cut = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  return JSON.stringify(cut);
}

function isValidKey(key) {
  return typeof key === 'string' && KEY_PATTERN.test(key) && !RESERVED_KEYS.has(key);
}

function isBlockedKey(key) {
  if (typeof key !== 'string') return false;
  const upper = key.toUpperCase();
  if (BLOCKED_KEYS.has(upper)) return true;
  return BLOCKED_PREFIXES.some((p) => upper.startsWith(p));
}

function isSecretKey(key) {
  return typeof key === 'string' && (SECRET_KEY_PATTERN.test(key) || SECRET_SUFFIX_PATTERN.test(key));
}

function isCredentialReference(value) {
  return typeof value === 'string' && CREDENTIAL_REF_PATTERN.test(value);
}

function newCredentialReference() {
  return CREDENTIAL_REF_PREFIX + crypto.randomBytes(16).toString('hex');
}

function credentialIdOf(ref) {
  return isCredentialReference(ref) ? ref.slice(CREDENTIAL_REF_PREFIX.length) : null;
}

function isValidAgentType(type) {
  return typeof type === 'string' && AGENT_TYPE_PATTERN.test(type) && !type.includes('..');
}

/** Why a key may not be saved, or null. */
function keyProblem(key) {
  if (!isValidKey(key)) {
    return 'not a valid variable name (letters, digits and _, not starting with a digit, at most 128 characters)';
  }
  if (isBlockedKey(key)) return 'runtime-control variables cannot be set through agent env';
  return null;
}

/**
 * Why a value cannot be saved, or null. `allowReference` is for values read
 * back from an env file, where a credential reference is what is expected.
 */
function valueProblem(value, { allowReference = false } = {}) {
  if (typeof value !== 'string') return 'value must be a string';
  if (value.length > MAX_VALUE_LENGTH) return `value is longer than ${MAX_VALUE_LENGTH} characters`;
  if (/[\r\n\0]/.test(value)) return 'value contains a line break or NUL character';
  if (!allowReference && CREDENTIAL_REF_PATTERN.test(value.trim())) {
    return 'value has the form of a credential reference';
  }
  return null;
}

function validateKey(key) {
  const problem = keyProblem(key);
  if (problem) throw new EnvValidationError(`env variable ${describeName(key)}`, problem);
}

function validateValue(key, value, opts) {
  const problem = valueProblem(value, opts);
  if (problem) throw new EnvValidationError(`env variable ${describeName(key)}`, problem);
}

function validateAgentType(type) {
  if (!isValidAgentType(type)) {
    throw new EnvValidationError(`agent type ${describeName(type)}`, 'not a valid agent type name');
  }
}

/** A null, undefined or empty value in an update means "remove this key". */
function isRemoval(value) {
  return value === null || value === undefined || value === '';
}

/**
 * An env update for the line-based env files, checked as a whole before
 * anything is written. Returns [key, value] pairs, value null for a removal.
 * Values are trimmed of surrounding spaces and tabs (the file format trims
 * them on read anyway); CR and LF are refused, never trimmed away.
 */
function validateEnvUpdates(env) {
  if (env === null || env === undefined) return [];
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw new EnvValidationError('env', 'must be an object of KEY: value pairs');
  }
  const out = [];
  for (const [key, value] of Object.entries(env)) {
    if (isRemoval(value)) {
      if (!isValidKey(key)) validateKey(key);
      out.push([key, null]);
      continue;
    }
    validateKey(key);
    validateValue(key, value);
    const trimmed = value.replace(/^[ \t]+|[ \t]+$/g, '');
    out.push([key, trimmed === '' ? null : trimmed]);
  }
  return out;
}

/**
 * A per-agent env map (daemon.yaml), checked strictly: everything in it is
 * handed to the agent as is.
 */
function validateEnvObject(env, { subject = 'env' } = {}) {
  if (env === null || env === undefined) return;
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw new EnvValidationError(subject, 'must be an object of KEY: value pairs');
  }
  for (const [key, value] of Object.entries(env)) {
    validateKey(key);
    validateValue(key, value, { allowReference: true });
  }
}

/**
 * The part of an env map that may reach an agent's environment: invalid
 * names, runtime-control variables and values that could not have been saved
 * are left out, each reported through `onDrop(key, reason)` with the key
 * (described) and never the value. Numbers and booleans become strings, as a
 * spawned environment would make them anyway.
 */
function sanitizeEnv(env, { onDrop } = {}) {
  const out = {};
  if (!env || typeof env !== 'object') return out;
  for (const [key, raw] of Object.entries(env)) {
    let value = raw;
    if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
    if (value === null || value === undefined) continue;
    const problem = keyProblem(key) || valueProblem(value, { allowReference: true });
    if (problem) {
      if (onDrop) onDrop(describeName(key), problem);
      continue;
    }
    out[key] = value;
  }
  return out;
}

module.exports = {
  KEY_PATTERN,
  MAX_VALUE_LENGTH,
  AGENT_TYPE_PATTERN,
  SECRET_KEY_PATTERN,
  CREDENTIAL_REF_PREFIX,
  CREDENTIAL_REF_PATTERN,
  BLOCKED_KEYS,
  BLOCKED_PREFIXES,
  EnvValidationError,
  describeName,
  isValidKey,
  isBlockedKey,
  isSecretKey,
  isCredentialReference,
  newCredentialReference,
  credentialIdOf,
  isValidAgentType,
  isRemoval,
  keyProblem,
  valueProblem,
  validateKey,
  validateValue,
  validateAgentType,
  validateEnvUpdates,
  validateEnvObject,
  sanitizeEnv,
};
