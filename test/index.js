'use strict';
// Node 21+ treats `node --test test/` as a module path (test/index.js) instead of scanning the directory.
// Older Node scans the directory itself, so this loader does nothing there to avoid running tests twice.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
if (parseInt(process.versions.node, 10) >= 21) {
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.mjs')).sort())
    import(pathToFileURL(path.join(__dirname, f)).href);
}
