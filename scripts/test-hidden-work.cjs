const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
async function main() {
  let calls = 0;
  let statusEvent;
  const timers = [], listeners = [];
  const makeElement = () => ({ textContent: '', title: '', classList: { add() {}, remove() {} }, setAttribute() {} });
  const dom = { homeDate: makeElement(), timeText: makeElement(), codexStatusDot: makeElement(), codexStatusLabel: makeElement() };
  global.document = { hidden: true, addEventListener: (name, cb) => { if (name === 'visibilitychange') listeners.push(cb); } };
  global.window = { setInterval: cb => timers.push(cb) };
  for (const [file, init] of [['clock.ts', 'initClock'], ['codex-status.ts', 'initCodexStatus']]) {
    const filename = path.resolve(__dirname, '../src/modules', file);
    const mod = new Module(filename, module);
    mod.require = name => name.includes('@tauri-apps/api')
      ? { invoke: async () => { calls++; return { phase: 'idle', updatedAt: 1, statusPath: '' }; }, listen: async (_name, cb) => { statusEvent = cb; return () => {}; } }
      : name === '../dom' ? dom : name === './minimize-drag' ? { applyIndicatorStatus() {} } : require(name);
    mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, filename);
    mod.exports[init]();
  }
  await Promise.resolve();
  assert.equal(calls, 0); assert.equal(dom.timeText.textContent, '');
  document.hidden = false; listeners.forEach(cb => cb()); await Promise.resolve();
  assert.equal(calls, 1); assert.match(dom.timeText.textContent, /^\d\d:\d\d:\d\d$/);
  if (statusEvent) {
    statusEvent({ payload: { phase: 'running', updatedAt: 2, statusPath: '' } });
    assert.equal(dom.codexStatusLabel.textContent, '工作');
    assert.equal(timers.length, 1, 'only the clock retains a timer; status has no polling timer');
  }
  document.hidden = true; timers.forEach(cb => cb()); await Promise.resolve();
  assert.equal(calls, 1, 'hidden capsule does not issue status IPC');
  if (statusEvent) {
    statusEvent({ payload: { phase: 'completed', updatedAt: 3, statusPath: '' } });
    assert.equal(dom.codexStatusLabel.textContent, '工作', 'hidden status events do not repaint the capsule');
    document.hidden = false; listeners.forEach(cb => cb()); await Promise.resolve();
    assert.equal(calls, 2, 'show reads the latest shared backend cache');
    assert.equal(dom.codexStatusLabel.textContent, '空闲');
  }
  console.log('PASS: hidden clock/status stay quiet; visibility restores fresh values');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
