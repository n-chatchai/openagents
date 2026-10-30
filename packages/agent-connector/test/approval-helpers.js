'use strict';

/**
 * Test helper (not a test file): a throwaway OpenAgents config dir whose
 * policy.json lets the named agents run unrestricted — what
 * `agn policy unrestricted add <name>` writes on a real computer. Suites that
 * exercise an execute turn of a runtime that needs that opt-in use it, so they
 * keep testing what they were written for.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePolicy, defaultPolicy } = require('../src/policy');

function unrestrictedConfigDir(...names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-policy-'));
  savePolicy(dir, { ...defaultPolicy(), unrestricted: names });
  return dir;
}

/** A config dir with the default policy (nobody unrestricted). */
function defaultConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-policy-'));
  savePolicy(dir, defaultPolicy());
  return dir;
}

module.exports = { unrestrictedConfigDir, defaultConfigDir };
