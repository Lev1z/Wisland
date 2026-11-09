// Pure picker hierarchy regression tests. Does not read local conversations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');
const filename = path.resolve(__dirname, '../src/session-options.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const loaded = new Module(filename, module); loaded._compile(compiled.outputText, filename);
const { buildSessionOptions } = loaded.exports;
const session = (id, label, parent) => ({ id, label, forkedFromId: parent ?? null, modified: 1 });
let tests = 0;
function test(name, run) { run(); tests++; console.log(`PASS: ${name}`); }
test('archived or missing parent: master is an independent named root', () => {
  const rows = buildSessionOptions([
    session('wisland', '安装 Wisland 项目'), session('wisland-fork', '安装 Wisland 项目', 'wisland'),
    session('01a1b00f', 'master', '01a17ae3'), session('01a17ae3', 'master', 'archived-parent'),
  ], '01a17ae3');
  assert.deepEqual(rows.map(r => [r.value, r.title, r.depth]), [
    ['', '自动跟随', 0], ['wisland', '安装 Wisland 项目', 0], ['wisland-fork', '分支 · wisland-', 1],
    ['01a17ae3', 'master', 0], ['01a1b00f', '分支 · 01a1b00f', 1],
  ]);
  assert.ok(rows[3].tooltip.includes('父会话未在当前列表中'));
  assert.ok(rows[3].tooltip.includes('archived-parent'));
});
test('same names never merge unrelated groups; nested forks preserve depth', () => {
  const rows = buildSessionOptions([session('r1', 'master'), session('r2', 'master'), session('child', 'renamed', 'r1'), session('grand', 'master', 'child')], null).slice(1);
  assert.deepEqual(rows.map(r => [r.value, r.depth]), [['r1', 0], ['child', 1], ['grand', 2], ['r2', 0]]);
});
test('parent leaving/returning to the limited list changes presentation, not IDs', () => {
  const child = session('child', 'renamed conversation', 'parent');
  const onlyChild = buildSessionOptions([child], child.id)[1];
  assert.equal(onlyChild.title, 'renamed conversation'); assert.equal(onlyChild.depth, 0);
  const together = buildSessionOptions([child, session('parent', 'original')], child.id).find(r => r.value === child.id);
  assert.equal(together.title, '分支 · child'); assert.equal(together.depth, 1);
  assert.equal(child.forkedFromId, 'parent');
});
test('cycles and self-parent records remain finite, unique and separately rooted', () => {
  const rows = buildSessionOptions([session('unrelated', 'real root'), session('a', 'cycle root', 'b'), session('b', 'cycle child', 'a'), session('self', 'self root', 'self')], null).slice(1);
  assert.deepEqual(rows.map(r => [r.value, r.depth]), [['unrelated', 0], ['a', 0], ['b', 1], ['self', 0]]);
  assert.equal(rows[1].title, 'cycle root'); assert.ok(rows[1].tooltip.includes('循环'));
  assert.equal(new Set(rows.map(r => r.value)).size, 4);
});
test('deep forks retain full logical depth and every selectable identity', () => {
  const rows = buildSessionOptions(Array.from({ length: 41 }, (_, i) => session(String(i), `name-${i}`, i ? String(i - 1) : null)), '40').slice(1);
  assert.equal(rows.length, 41); assert.equal(rows[40].depth, 40); assert.equal(rows[40].value, '40');
});
test('empty catalog still provides auto-follow', () => {
  const rows = buildSessionOptions([], null);
  assert.equal(rows.length, 1); assert.equal(rows[0].value, '');
});
console.log(`PASS: ${tests} picker hierarchy tests`);
