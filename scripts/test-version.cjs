// Keep build metadata and the offline HTML fallback in sync.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const version = JSON.parse(read('package.json')).version;
const lock = JSON.parse(read('package-lock.json'));
assert.equal(lock.version, version);
assert.equal(lock.packages[''].version, version);
assert.equal(JSON.parse(read('src-tauri/tauri.conf.json')).version, version);
assert.equal(read('src-tauri/Cargo.toml').match(/^version = "([^"]+)"/m)[1], version);
assert.equal(read('src-tauri/Cargo.lock').match(/name = "wisland"\r?\nversion = "([^"]+)"/)[1], version);
const labels = [...read('settings.html').matchAll(/data-app-version>([^<]+)</g)].map(match => match[1]);
assert.deepEqual(labels, [version, version], 'sidebar and About must show the current fallback version');
assert.ok(read('src/settings.ts').includes('getVersion()'), 'settings must also read the installed application version');
console.log(`PASS: version ${version} matches manifests, locks, sidebar and About.`);
