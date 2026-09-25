// Run before every publish: load the built package the way consumers do, both
// ways, and fail if either entry point exports nothing. 1.0.0 shipped a
// CommonJS build that Node loaded as an ES module, so require() returned {}.
const assert = require('node:assert');
const path = require('node:path');

const pkg = require('../package.json');
const root = path.join(__dirname, '..');

const cjs = require(path.join(root, pkg.exports['.'].require));
assert.equal(typeof cjs.SiteQwalityRUM?.init, 'function', 'require() must export SiteQwalityRUM.init');

import(path.join(root, pkg.exports['.'].import)).then((esm) => {
  assert.equal(typeof esm.SiteQwalityRUM?.init, 'function', 'import must export SiteQwalityRUM.init');
  console.log(`check-package: ${pkg.name}@${pkg.version} exports SiteQwalityRUM from both entry points`);
});
