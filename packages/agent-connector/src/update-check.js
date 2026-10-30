'use strict';

/**
 * Update check + prompt flow.
 *
 * Queries the npm registry for the latest @openagents-org/agent-launcher
 * version and, if newer than the running version, prints a notification.
 * Nothing here installs on its own: `agn update` does, run by a person.
 *
 * What `agn update` trusts (verifiedUpdate): the exact version it installs
 * (the one named with --version, else npm's `latest`), and that version's
 * sha512 integrity as the npm registry publishes it — or as given with
 * --integrity, which must then agree with the registry. The tarball is
 * downloaded, hashed here and installed from that file; a mismatch installs
 * nothing. It never installs a floating `@latest` spec. What it cannot catch
 * is a registry that publishes a malicious version under a matching hash:
 * --integrity from a source the person trusts is the answer to that.
 */

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { npmUrls } = require('./mirrors');
const { whereBinary } = require('./paths');
const { isSha512Integrity, verifyFileIntegrity } = require('./install-verify');

const PKG_NAME = '@openagents-org/agent-launcher';
const CACHE_FILE = path.join(os.homedir(), '.openagents', '.update-check.json');
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function currentVersion() {
  return require('../package.json').version;
}

function compareSemver(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function loadCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    if (data && data.latest && data.checkedAt &&
        Date.now() - data.checkedAt < CACHE_TTL_MS) {
      return data.latest;
    }
  } catch {}
  return null;
}

function saveCache(latest) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ latest, checkedAt: Date.now() }));
  } catch {}
}

function fetchLatestFrom(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.request(
      url,
      { method: 'GET', timeout: timeoutMs, headers: { Accept: 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed.version || null);
          } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * Ask each registry in turn (mirror first in China) with a per-origin budget,
 * so the check either answers quickly or gives up quietly — it must never be
 * what makes the CLI feel slow to start.
 */
async function fetchLatest(timeoutMs = 2500) {
  const urls = npmUrls(`${PKG_NAME}/latest`);
  const perOrigin = Math.max(1200, Math.floor(timeoutMs / urls.length));
  for (const url of urls) {
    const version = await fetchLatestFrom(url, perOrigin);
    if (version) return version;
  }
  return null;
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.request(
      url,
      { method: 'GET', timeout: timeoutMs, headers: { Accept: 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * The registry's record of one exact version: { version, integrity, tarball },
 * or null when no registry answers.
 */
async function fetchVersionMeta(version, timeoutMs = 10000) {
  for (const url of npmUrls(`${PKG_NAME}/${encodeURIComponent(version)}`)) {
    const doc = await fetchJson(url, timeoutMs);
    if (doc && doc.version && doc.dist) {
      return { version: doc.version, integrity: doc.dist.integrity || null, tarball: doc.dist.tarball || null };
    }
  }
  return null;
}

/**
 * Return { current, latest, isNewer } or null if the check failed / offline.
 */
async function checkForUpdate() {
  const current = currentVersion();
  let latest = loadCache();
  if (!latest) {
    latest = await fetchLatest();
    if (latest) saveCache(latest);
  }
  if (!latest) return null;
  return { current, latest, isNewer: compareSemver(latest, current) > 0 };
}

/**
 * Derive the npm `--prefix` for a global install from the npm binary location.
 *
 * npm resolves `-g` installs relative to a PREFIX, and the layout differs by
 * platform:
 *   Unix:    packages → {prefix}/lib/node_modules   (npm bin at {prefix}/bin)
 *   Windows: packages → {prefix}/node_modules        (npm bin at {prefix})
 *
 * So the prefix is the PARENT of npm's bin dir on Unix, and the bin dir itself
 * on Windows. The previous implementation walked up to the enclosing
 * node_modules and returned the directory containing it — which on Unix is
 * `{prefix}/lib`. Passing THAT as `--prefix` made npm append `lib/node_modules`
 * again, installing into `{prefix}/lib/lib/node_modules` while the running `agn`
 * (loaded from `{prefix}/lib/node_modules`) never changed: `agn update` reported
 * success but silently no-op'd on every Unix host.
 */
function npmPrefixFromBin(npmBin, platform = process.platform) {
  if (!npmBin) return null;
  // Use the target platform's path semantics so a Windows path resolves
  // correctly even when this runs on a POSIX host (and vice versa).
  const p = platform === 'win32' ? path.win32 : path.posix;
  const binDir = p.dirname(npmBin);
  // A bare name (e.g. 'npm' from the PATH hard-fallback) has no usable
  // directory — let npm resolve its own default global prefix instead.
  if (binDir === '.' || binDir === '') return null;
  return platform === 'win32' ? binDir : p.dirname(binDir);
}

/**
 * Detect when the running launcher lives in an *isolated runtime* — the local
 * npm project install.sh creates at `~/.openagents/nodejs`, where the package
 * is at `<dir>/node_modules/@openagents-org/agent-launcher` and `<dir>` has its
 * own `package.json`.
 *
 * This matters because a `-g` install (what a normal global/nvm install needs)
 * lands in `<dir>/lib/node_modules`, but the isolated runtime's daemon loads
 * from `<dir>/node_modules` — so `agn update` would report success while the
 * running code never changed (the acen "update no-op" incident). For an
 * isolated runtime we must do a *local* install into `<dir>` instead.
 *
 * Returns the project dir (`<dir>`) for an isolated runtime, else null (caller
 * falls back to the global `-g` path). Global/nvm layouts are excluded: their
 * package sits under `.../lib/node_modules` (basename 'lib') and the prefix
 * root has no package.json.
 */
function isolatedRuntimeDir(opts = {}) {
  const dir = opts.dir || __dirname; // <pkgRoot>/src
  const exists = opts.exists || fs.existsSync;
  // Path impl is injectable so tests can force POSIX/Windows semantics
  // regardless of the host OS (mirrors npmPrefixFromBin's `platform`).
  const p = opts.path || path;
  try {
    const pkgRoot = p.resolve(dir, '..');              // .../agent-launcher
    const nodeModules = p.resolve(pkgRoot, '..', '..'); // .../node_modules
    if (p.basename(nodeModules) !== 'node_modules') return null;
    const projectDir = p.resolve(nodeModules, '..');    // dir containing node_modules
    // Global npm layout is <prefix>/lib/node_modules — not an isolated project.
    if (p.basename(projectDir) === 'lib') return null;
    // A real local project has its own package.json; a global prefix does not.
    if (!exists(p.join(projectDir, 'package.json'))) return null;
    return projectDir;
  } catch {
    return null;
  }
}

/**
 * Locate the npm executable next to the running node binary, falling back to
 * a PATH lookup. On Windows the runnable file is `npm.cmd`; the extensionless
 * `npm` shipped alongside it is a Unix shell script that cmd.exe / PowerShell
 * cannot execute, so it must be checked AFTER `npm.cmd`. The opts are injectable
 * to keep this testable across platforms.
 */
function findNpmBin(opts = {}) {
  const platform = opts.platform || process.platform;
  const nodeDir = opts.nodeDir || path.dirname(process.execPath);
  const exists = opts.exists || fs.existsSync;
  const names = platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'];
  for (const name of names) {
    const candidate = path.join(nodeDir, name);
    if (exists(candidate)) return candidate;
  }
  // PATH fallback (injectable so tests can exercise the hard fallback
  // deterministically regardless of the host OS).
  // Walked in-process rather than via `where`, whose OEM-codepage output
  // mangled non-ASCII profile paths.
  const lookup = opts.lookup || (() => whereBinary('npm'));
  try {
    return lookup() || (platform === 'win32' ? 'npm.cmd' : 'npm');
  } catch { return platform === 'win32' ? 'npm.cmd' : 'npm'; }
}

/** How npm is started on this platform: [file, argv]. npm.cmd needs cmd.exe. */
function npmInvocation(npmBin, args, platform) {
  if (platform === 'win32') return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', npmBin, ...args]];
  return [npmBin, args];
}

/**
 * Download `<pkg>@<version>`'s tarball into `dir` with `npm pack` (no
 * scripts run), and return its path. Blocking; throws when npm fails.
 */
function packTarball(opts = {}) {
  const platform = opts.platform || process.platform;
  const spawn = opts.spawn || spawnSync;
  const npmBin = opts.npmBin || findNpmBin({ platform });
  const [cmd, cmdArgs] = npmInvocation(npmBin, ['pack', opts.spec, '--ignore-scripts', '--loglevel=error'], platform);
  const r = spawn(cmd, cmdArgs, { cwd: opts.dir, encoding: 'utf-8', windowsHide: true });
  if (r && r.error) throw new Error(`could not run npm (${cmd}): ${r.error.message}`);
  const files = fs.readdirSync(opts.dir).filter((f) => f.endsWith('.tgz'));
  if (!r || r.status !== 0 || files.length !== 1) {
    const why = String((r && (r.stderr || r.stdout)) || '').trim().split(/\r?\n/).slice(-4).join(' ');
    throw new Error(`could not download ${opts.spec}${why ? `: ${why}` : ''}`);
  }
  return path.join(opts.dir, files[0]);
}

/**
 * Install the launcher from a tarball already checked (verifiedUpdate). Blocking.
 * Returns true on success. Without `opts.tarball` it refuses: a bare
 * `<pkg>@latest` install is what this replaced. `opts` are injectable for testing.
 */
function runUpdate(opts = {}) {
  const platform = opts.platform || process.platform;
  const spawn = opts.spawn || spawnSync;
  const tarball = opts.tarball;
  if (!tarball || !path.isAbsolute(String(tarball))) {
    process.stderr.write('[launcher] Refusing to update without a verified package (agn update checks it first).\n');
    return false;
  }
  const npmBin = opts.npmBin || findNpmBin({ platform });
  const isoDir = opts.isolatedDir !== undefined ? opts.isolatedDir : isolatedRuntimeDir();

  let args;
  if (isoDir) {
    // Isolated runtime (install.sh's ~/.openagents/nodejs): a LOCAL npm project
    // whose package lives in <dir>/node_modules — NOT <dir>/lib/node_modules.
    // A `-g` install lands in lib/node_modules and silently no-ops the running
    // launcher/daemon (which loads from node_modules). Install locally into the
    // project dir instead. `--no-save` leaves package.json untouched (install.sh
    // owns it), and because <dir>'s package.json already lists our deps npm has
    // nothing extraneous to prune.
    args = ['install', '--no-save', tarball, '--prefix', isoDir];
  } else {
    // Global / nvm install. A LOCAL install (`npm install <pkg> --prefix <dir>`)
    // here would treat <dir> as a project root and prune every node_modules
    // entry not reachable from its package.json — deleting node's own bundled
    // npm/corepack. A global install only adds/updates the named package into
    // <prefix>/node_modules and never prunes its siblings.
    const prefix = opts.prefix !== undefined ? opts.prefix : npmPrefixFromBin(npmBin, platform);
    args = ['install', '-g', tarball];
    if (prefix) args.push('--prefix', prefix);
  }

  // On Windows, npm.cmd is a batch file and must be invoked through cmd.exe.
  // Passing the args via cmd.exe with shell:false lets Node quote paths that
  // contain spaces (e.g. C:\Program Files\nodejs\npm.cmd) correctly.
  const [cmd, cmdArgs] = npmInvocation(npmBin, args, platform);

  process.stderr.write(`[launcher] Running: ${npmBin} ${args.join(' ')}\n`);
  const r = spawn(cmd, cmdArgs, { stdio: 'inherit' });

  // spawn failed to even start the process (ENOENT / EINVAL / EACCES ...).
  if (r && r.error) {
    process.stderr.write(`[launcher] Failed to run npm (${cmd}): ${r.error.message}\n`);
    return false;
  }
  // npm started but exited non-zero. Its own stderr was already streamed via
  // stdio:'inherit'; surface the exit code so the failure isn't silent.
  if (!r || r.status !== 0) {
    const code = r ? r.status : 'unknown';
    const sig = r && r.signal ? ` (signal ${r.signal})` : '';
    process.stderr.write(`[launcher] npm exited with code ${code}${sig}\n`);
    return false;
  }
  return true;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Update the launcher to exactly `opts.version`, installing only a tarball
 * whose sha512 matches the registry's record for that version (and
 * `opts.integrity`, when given). Returns { ok: true, integrity } or
 * { ok: false, error }. `fetchMeta`, `pack` and the runUpdate seams are
 * injectable for tests.
 */
async function verifiedUpdate(opts = {}) {
  const version = String(opts.version || '').trim();
  if (!EXACT_VERSION.test(version)) {
    return { ok: false, error: `'${version}' is not an exact version (for example: agn update --version 0.2.209)` };
  }
  if (opts.integrity !== undefined && !isSha512Integrity(opts.integrity)) {
    return { ok: false, error: '--integrity must be the sha512-… value npm publishes for that version' };
  }
  const meta = await (opts.fetchMeta || fetchVersionMeta)(version);
  if (!meta || meta.version !== version) {
    return { ok: false, error: `could not read ${PKG_NAME}@${version} from the npm registry` };
  }
  if (!isSha512Integrity(meta.integrity)) {
    return { ok: false, error: `the registry publishes no sha512 checksum for ${PKG_NAME}@${version}; nothing was installed` };
  }
  if (opts.integrity && opts.integrity !== meta.integrity) {
    return {
      ok: false,
      error: `the checksum given (${opts.integrity}) is not what the registry publishes for ${version} (${meta.integrity}); nothing was installed`,
    };
  }
  const expected = opts.integrity || meta.integrity;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-update-'));
  try {
    let tarball;
    try {
      tarball = (opts.pack || packTarball)({ ...opts, spec: `${PKG_NAME}@${version}`, dir });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const check = verifyFileIntegrity(tarball, expected);
    if (!check.ok) {
      return {
        ok: false,
        error: `the downloaded package does not match its checksum (expected ${expected}, got ${check.actual}); nothing was installed`,
      };
    }
    const ok = (opts.runUpdate || runUpdate)({ ...opts, tarball });
    return ok ? { ok: true, integrity: expected } : { ok: false, error: 'npm could not install the verified package' };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Prompt for a Y/n keystroke. Defaults to Y on empty input.
 * Times out after `timeoutMs` and returns false.
 */
function promptYes(question, timeoutMs = 30000) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return resolve(false);
    process.stderr.write(question);
    let answered = false;
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const timer = setTimeout(() => {
      if (answered) return;
      answered = true;
      process.stderr.write('\n');
      rl.close();
      resolve(false);
    }, timeoutMs);
    rl.question('', (ans) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      rl.close();
      const a = (ans || '').trim().toLowerCase();
      resolve(a === '' || a === 'y' || a === 'yes');
    });
  });
}

/**
 * Check and print a warning if a newer version is available.
 * Never prompts or auto-updates — users run `agn update` explicitly.
 */
async function notifyAndMaybeUpdate() {
  let info;
  try { info = await checkForUpdate(); } catch { return; }
  if (!info || !info.isNewer) return;

  process.stderr.write(
    `\n[launcher] Update available: ${info.current} → ${info.latest}\n` +
    '[launcher] Run `agn update` to upgrade.\n\n'
  );
}

module.exports = {
  checkForUpdate,
  notifyAndMaybeUpdate,
  runUpdate,
  verifiedUpdate,
  fetchVersionMeta,
  packTarball,
  findNpmBin,
  npmPrefixFromBin,
  isolatedRuntimeDir,
  currentVersion,
};
