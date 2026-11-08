// Pure presentation-model tests. No app, local sessions, or account access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');
const filename = path.resolve(__dirname, '../src/runtime-detail.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const moduleUnderTest = new Module(filename, module);
moduleUnderTest._compile(compiled.outputText, filename);
const { overviewFor, parseContainer } = moduleUnderTest.exports;
function entry(kind, payload, content = 'retained text', extra = {}) {
  return {
    event: { id: 'r:1', kind, sourceType: `response_item.${kind}`, summary: 'summary', turnId: 't1', turnNumber: 1, modelCall: null, status: null, callId: 'call-1', timestamp: null, ...extra },
    detail: { raw: { payload }, content, byteOffset: 1, rolloutId: 'r' }, related: [],
  };
}
let tests = 0;
function test(name, run) { run(); tests++; console.log(`PASS: ${name}`); }
test('decode valid JSON containers only; literal escapes and invalid/truncated input survive', () => {
  assert.deepEqual(parseContainer('{"cmd":"echo a\\nb"}'), { cmd: 'echo a\nb' });
  for (const value of ['C:\\new\\test', 'line\\nnext', '{"cmd":"oops', '"text"', 'false', '0']) assert.equal(parseContainer(value), value);
});
test('tool command appears once and additional arguments remain available', () => {
  const model = overviewFor(entry('tool', { name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test', workdir: 'D:\\code', max_output_tokens: 0 }) }, 'exec_command {"cmd":"npm test"}'));
  assert.equal(model.title, 'exec_command');
  assert.equal(model.blocks.filter(b => b.text.includes('npm test')).length, 1);
  assert.equal(model.blocks[0].title, '命令');
  assert.equal(model.blocks[1].secondary, true);
  assert.ok(model.blocks[1].text.includes('max_output_tokens'));
  assert.deepEqual(model.facts, [], 'no fabricated status/duration');
});
test('custom tools, command arrays and malformed input remain lossless', () => {
  const patch = '*** Begin Patch\n+const path = "C:\\new";\n*** End Patch';
  assert.equal(overviewFor(entry('tool', { name: 'apply_patch', input: patch })).blocks[0].text, patch);
  assert.equal(overviewFor(entry('tool', { command: ['npm', 'test'] })).blocks[0].text, '[\n  "npm",\n  "test"\n]');
  assert.equal(overviewFor(entry('tool', { arguments: '{"cmd":"truncated… [已截断]' })).blocks[0].text, '{"cmd":"truncated… [已截断]');
});
test('paginated records unwrap item for calls AND related results', () => {
  const call = entry('tool', { type: 'item_completed', item: { type: 'CommandExecution', command: 'npm test', aggregated_output: 'passed', exit_code: 0, status: 'completed', duration_ms: 420 } });
  const model = overviewFor(call);
  assert.equal(model.blocks[0].text, 'npm test');
  assert.equal(model.blocks[1].text, 'passed');
  assert.equal(model.facts.find(f => f.label === '耗时').value, '0.42 s');
  call.related = [entry('result', { item: { output: 'nested result' } })];
  assert.ok(overviewFor(call).blocks.some(b => b.text === 'nested result'));
});
test('execution wrapper: output once, exit code up front, extra fields retained', () => {
  const model = overviewFor(entry('result', { output: JSON.stringify({ output: 'failed assertion', exit_code: 1, wall_time_seconds: 0.9, session_id: 123, stderr: 'stderr detail' }) }, 'duplicate output'));
  assert.equal(model.blocks[0].text, 'failed assertion');
  assert.equal(model.blocks.filter(b => b.text.includes('failed assertion')).length, 1);
  assert.equal(model.facts.find(f => f.label === '退出码').tone, 'error');
  assert.equal(model.facts.find(f => f.label === '耗时').value, '0.9 s');
  assert.ok(model.blocks.find(b => b.title === '输出附加字段').text.includes('session_id'));
  assert.ok(model.blocks.find(b => b.title === '标准错误输出').error);
  const combined = overviewFor(entry('tool', { name: 'exec', command: 'test', result: { output: 'done', exit_code: 0 } }));
  assert.equal(combined.facts.find(f => f.label === '退出码').value, '0', 'combined call/result records keep output facts');
});
test('completion is not success; zero, false, empty and unknown units are preserved', () => {
  const model = overviewFor(entry('result', { output: '', status: 'completed', success: false, exit_code: 0, duration: 5 }));
  assert.equal(model.blocks[0].text, '（空输出）');
  assert.equal(model.facts.find(f => f.label === '状态').tone, undefined);
  assert.equal(model.facts.find(f => f.label === '执行成功').value, '否');
  assert.equal(model.facts.find(f => f.label === '退出码').value, '0');
  assert.ok(model.facts.some(f => f.label === '耗时（原值）'));
  assert.equal(overviewFor(entry('result', { output: false })).blocks[0].text, 'false');
});
test('text-only output blocks unwrap; mixed/unknown blocks do not disappear', () => {
  assert.equal(overviewFor(entry('result', { output: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).blocks[0].text, 'a\nb');
  const model = overviewFor(entry('result', { output: [{ type: 'text', text: 'a' }, { type: 'image', image_url: '[omitted]' }] }));
  assert.equal(model.blocks[0].format, 'json');
  assert.ok(model.blocks[0].text.includes('image'));
});
test('related command is collapsed under result, not duplicated as prose', () => {
  const result = entry('result', { output: 'done' }, 'done');
  result.related = [entry('tool', { item: { name: 'exec', arguments: '{"cmd":"npm test"}' } })];
  const model = overviewFor(result);
  assert.equal(model.blocks[0].text, 'done');
  assert.equal(model.blocks[1].text, 'npm test');
  assert.equal(model.blocks[1].secondary, true);
});
test('messages use Markdown, mirror stays out of overview, identifiers stay technical', () => {
  for (const kind of ['user', 'assistant', 'summary', 'system']) {
    const detail = entry(kind, { type: 'message' }, '# Heading\n\n- item');
    detail.detail.mirror = { payload: { content: 'MIRROR_SENTINEL' } };
    const model = overviewFor(detail);
    assert.equal(model.blocks[0].format, 'markdown');
    assert.equal(model.blocks[0].text, '# Heading\n\n- item');
    assert.ok(!JSON.stringify(model).includes('MIRROR_SENTINEL'));
    assert.equal(model.technical.call_id, 'call-1');
  }
});
test('model facts use recorded usage and mirror fallback, never inferred timings', () => {
  const detail = entry('model', { usage: { input_tokens: 100, total_tokens: 120 }, model: 'recorded-model' }, '', { status: 'completed', modelCall: { responseId: 'resp-1', number: 4 } });
  detail.detail.mirror = { payload: { token_usage: { output_tokens: 20, total_tokens: 999, extra_tokens: 5 } } };
  const model = overviewFor(detail);
  assert.equal(model.title, '模型调用 #4');
  assert.equal(model.facts.find(f => f.label === '输入 token').value, '100');
  assert.equal(model.facts.find(f => f.label === '输出 token').value, '20');
  assert.equal(model.facts.find(f => f.label === '合计 token').value, '120');
  assert.ok(!model.facts.some(f => f.label.includes('耗时')));
  assert.ok(model.blocks[0].text.includes('extra_tokens'));
});
test('unknown records fall back to payload, errors remain visible', () => {
  assert.ok(overviewFor(entry('context', { type: 'future_event', extra: 7 })).blocks[0].text.includes('extra'));
  const model = overviewFor(entry('error', { error: { message: 'failed' } }, 'failed to run'));
  assert.ok(model.blocks.every(b => b.error));
});
console.log(`PASS: ${tests} Inspector presentation-model tests`);
