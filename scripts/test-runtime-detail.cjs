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
  assert.equal(model.title, '执行命令');
  assert.equal(model.blocks.filter(b => b.text.includes('npm test')).length, 1);
  assert.equal(model.blocks[0].title, '执行的命令');
  assert.equal(model.blocks[1].secondary, true);
  assert.ok(model.blocks[1].text.includes('max_output_tokens'));
  assert.deepEqual(model.facts, [{ label: '工作目录', value: 'D:\\code' }], 'only recorded directory; no fabricated status/duration');
  assert.ok(model.lead.text.includes('未附带执行结果'));
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
  assert.equal(model.facts.find(f => f.label === '耗时').value, '0.42 秒');
  call.related = [entry('result', { item: { output: 'nested result' } })];
  assert.ok(overviewFor(call).blocks.some(b => b.text === 'nested result'));
});
test('execution wrapper: output once, exit code up front, extra fields retained', () => {
  const model = overviewFor(entry('result', { output: JSON.stringify({ output: 'failed assertion', exit_code: 1, wall_time_seconds: 0.9, session_id: 123, stderr: 'stderr detail' }) }, 'duplicate output'));
  assert.equal(model.blocks[0].text, 'failed assertion');
  assert.equal(model.blocks.filter(b => b.text.includes('failed assertion')).length, 1);
  assert.equal(model.facts.find(f => f.label === '退出码').tone, 'error');
  assert.equal(model.facts.find(f => f.label === '耗时').value, '0.9 秒');
  assert.ok(model.blocks.find(b => b.title === '输出附加字段').text.includes('session_id'));
  assert.ok(model.blocks.find(b => b.title === '标准错误输出').error);
  const combined = overviewFor(entry('tool', { name: 'exec', command: 'test', result: { output: 'done', exit_code: 0 } }));
  assert.equal(combined.lead.text, '进程正常退出');
  assert.equal(combined.technical.exit_code, 0, 'command exit code remains available in technical details');
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
  assert.ok(overviewFor(entry('record', { type: 'future_event', extra: 7 })).blocks[0].text.includes('extra'));
  const model = overviewFor(entry('error', { error: { message: 'failed' } }, 'failed to run'));
  assert.ok(model.blocks.every(b => b.error));
});
test('command execution shows the real shell command, not launcher plumbing', () => {
  const argv = ['C:\\Program Files\\Runtime\\pwsh.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'node scripts/test-tray-ui.cjs'];
  const call = entry('tool', { type: 'item_completed', item: {
    type: 'CommandExecution', command: argv, status: 'completed', exit_code: 0, duration_ms: 107582,
    aggregated_output: 'PASS: 36 sidebar UI scenarios (6 quota states × 2 themes × 3 DPI scales)\nScreenshots: C:\\new\\test',
  } });
  const before = JSON.stringify(call);
  const model = overviewFor(call);
  assert.equal(model.title, '执行命令');
  assert.equal(model.lead.text, '进程正常退出');
  assert.equal(model.lead.tone, 'success');
  assert.equal(model.blocks[0].text, 'node scripts/test-tray-ui.cjs');
  assert.deepEqual(model.technical.command_argv, argv);
  assert.equal(model.technical.exit_code, 0);
  assert.equal(model.facts.find(f => f.label === '耗时').value, '1 分 47.6 秒');
  assert.equal(model.blocks[1].report, '输出报告：36 组界面测试通过');
  assert.ok(model.blocks[1].text.includes('C:\\new\\test'));
  assert.equal(JSON.stringify(call), before, 'presentation never mutates the raw tab');
});
test('only recognized single-command launcher shapes are abbreviated', () => {
  for (const argv of [['bash', '-lc', 'echo "a b"'], ['cmd.exe', '/d', '/s', '/c', 'echo hi']]) {
    const model = overviewFor(entry('tool', { command: argv }));
    assert.equal(model.blocks[0].text, argv.at(-1));
    assert.deepEqual(model.technical.command_argv, argv);
  }
  for (const argv of [
    ['node', 'a b.js'], ['pwsh', '-EncodedCommand', 'abc'], ['pwsh', '-Command', 'echo', 'hi'],
    ['pwsh', '-Unknown', '-Command', 'echo hi'], ['pwsh', '-Command', 7], ['bash', '-c', 'echo hi', 'extra'],
  ]) {
    assert.equal(overviewFor(entry('tool', { command: argv })).blocks[0].text, JSON.stringify(argv, null, 2));
  }
});
const wrapped = returns => 'Script completed\nWall time 5.1 seconds\nOutput:\n' + returns.map(r => JSON.stringify(r)).join('\n');
const returned = (output, extra = {}) => ({ chunk_id: 'part', wall_time_seconds: 0.4, exit_code: 0, output, ...extra });
test('batch returns become independent decoded results with scoped timing', () => {
  const output = wrapped([
    returned('PASS: 36 sidebar UI scenarios, all passed\nC:\\new\\test', { original_token_count: 71 }),
    returned('71f1044 fix: tray toggle\nfile.png\n', { wall_time_seconds: 0.6 }),
  ]);
  const detail = entry('result', { output }, output);
  const model = overviewFor(detail);
  assert.equal(model.title, '批量调用结果');
  assert.equal(model.lead.text, '收到 2 条返回，各项结果如下');
  assert.equal(model.lead.tone, undefined, 'outer script completion is not an aggregate success');
  assert.deepEqual(model.facts, [{ label: '外层脚本耗时', value: '5.1 秒' }]);
  const returns = model.blocks.filter(b => b.notice);
  assert.equal(returns.length, 2);
  assert.equal(returns[0].text, 'PASS: 36 sidebar UI scenarios, all passed\nC:\\new\\test');
  assert.equal(returns[0].report, '输出报告：36 组界面测试通过');
  assert.equal(returns[0].facts.find(f => f.label === '耗时').value, '0.4 秒');
  assert.equal(returns[1].facts.find(f => f.label === '耗时').value, '0.6 秒');
  assert.equal(returns[1].text, '71f1044 fix: tray toggle\nfile.png\n');
  assert.ok(model.blocks.filter(b => b.secondary).every(b => b.text.includes('chunk_id')));
  assert.equal(detail.detail.raw.payload.output, output);
});
test('batch failures, active process handles and missing exit status stay separate', () => {
  const model = overviewFor(entry('result', { status: 'completed', duration_ms: 9999, output: wrapped([
    returned('failure', { exit_code: 2 }),
    { chunk_id: 'pending', session_id: 123, output: 'not settled' },
  ]) }));
  assert.equal(model.lead.tone, 'error');
  assert.ok(model.lead.text.includes('1 条异常'), 'failure is visible before scrolling to the child result');
  const returns = model.blocks.filter(b => b.notice);
  assert.equal(returns[0].notice.text, '进程异常退出（退出码 2）');
  assert.equal(returns[1].notice.tone, undefined);
  assert.ok(returns[1].notice.text.includes('未记录退出状态'));
  assert.deepEqual(returns[1].facts, [], 'no inheritance of outer completion or duration');
  assert.ok(model.blocks.some(b => b.secondary && b.text.includes('session_id')));
});
test('batch scanner respects JSON strings, escaped quotes and literal paths', () => {
  const output = 'nested braces } { [ ] \\" quote "\nC:\\new\\test';
  const model = overviewFor(entry('result', { output: wrapped([returned(output), returned('next')]).replaceAll('\n', '\r\n') }));
  assert.equal(model.blocks[0].text, output);
  assert.equal(model.blocks.filter(b => b.notice).length, 2);
  const blocks = overviewFor(entry('result', { output: [{ type: 'text', text: wrapped([returned('done')]) }] }));
  assert.equal(blocks.title, '脚本调用结果');
});
test('unrecognized, mixed, oversized and truncated wrappers fall back intact', () => {
  const valid = wrapped([returned('a')]);
  const tooMany = wrapped(Array.from({ length: 33 }, () => returned('a')));
  for (const text of [valid.slice(0, -1), valid + '\ntrailing prose', valid.replace('Output:\n', 'Output:\nextra\n'),
    wrapped([{ output: 'not a known return' }]), valid.replace('Script completed', 'Script running'),
    wrapped([returned('x'.repeat(128 * 1024))]), tooMany,
    'ordinary prose\n' + JSON.stringify(returned('x')), '{"output":"not complete… [已截断]',
  ]) {
    const model = overviewFor(entry('result', { output: text }));
    assert.equal(model.title, '执行结果');
    assert.equal(model.blocks[0].text, text);
  }
});
test('failure evidence takes priority over exit zero and PASS text', () => {
  const model = overviewFor(entry('tool', { command: 'test', exit_code: 0, success: false,
    output: 'PASS: 36 sidebar UI scenarios (reported)\nFAIL: later validation' }));
  assert.equal(model.lead.tone, 'error');
  assert.ok(model.blocks[1].text.includes('FAIL:'));
  assert.equal(model.blocks[1].report, '输出报告：36 组界面测试通过', 'report attribution is not overall success');
  assert.equal(overviewFor(entry('tool', { command: 'test', status: 'completed' })).lead.tone, undefined);
});
test('turn completion promotes final Markdown and turn-scoped timing', () => {
  const message = '**完成并提交** `71f1044`\n\n- 第一项\n- 第二项';
  const model = overviewFor(entry('lifecycle', { type: 'task_complete', duration_ms: 560760,
    time_to_first_token_ms: 3560, started_at: 1794199460, completed_at: 1794200021,
    last_agent_message: message, root_turn_id: 'root-id', future_field: 7 }));
  assert.equal(model.title, '本轮已结束');
  assert.deepEqual(model.facts.map(({ label, value }) => ({ label, value })), [{ label: '本轮耗时', value: '9 分 20.8 秒' }, { label: '本轮首 token', value: '3.56 秒' }]);
  assert.equal(model.blocks[0].text, message);
  assert.equal(model.blocks[0].format, 'markdown');
  assert.equal(model.blocks[0].title, '最终回复');
  assert.ok(model.blocks[1].secondary && model.blocks[1].text.includes('future_field'));
  assert.equal(model.technical.root_turn_id, 'root-id');
  assert.equal(model.technical.started_at, 1794199460);
  assert.equal(model.lead, undefined, 'a completed turn is not declared successful');
});
test('turn start, interruption, errors, zero timing and missing reply have explicit templates', () => {
  assert.equal(overviewFor(entry('lifecycle', { type: 'turn_started' })).title, '本轮已开始');
  for (const type of ['task_started', 'turn_started']) {
    assert.equal(overviewFor(entry('lifecycle', { type })).lead, undefined, 'turn start has no explanatory banner or missing-final-reply prompt');
  }
  const abort = overviewFor(entry('lifecycle', { type: 'turn_aborted', reason: 'user cancelled' }));
  assert.equal(abort.title, '本轮已中断');
  assert.equal(abort.blocks[0].text, 'user cancelled');
  assert.equal(abort.blocks[0].error, true);
  const fail = overviewFor(entry('lifecycle', { type: 'task_complete', error: 'timeout' }));
  assert.equal(fail.title, '本轮执行失败');
  assert.equal(fail.blocks[0].text, 'timeout');
  const zero = overviewFor(entry('lifecycle', { type: 'turn_complete', duration_ms: 0, time_to_first_token_ms: 0 }));
  assert.deepEqual(zero.facts.map(f => f.value), ['0 秒', '0 秒']);
  assert.ok(zero.lead.text.includes('未附带最终回复'));
  const unknown = overviewFor(entry('lifecycle', { type: 'future_lifecycle', extra: 7 }));
  assert.ok(unknown.blocks[0].text.includes('extra'));
});
test('report badges quote explicit runner statements and preserve unsupported content', () => {
  assert.equal(overviewFor(entry('result', { output: 'PASS: 12 parser tests' })).blocks[0].report, '输出报告：12 项测试通过');
  assert.equal(overviewFor(entry('result', { output: 'test result: ok. 50 passed; 0 failed; 1 ignored' })).blocks[0].report, '输出报告：50 项测试通过');
  for (const text of ['expected PASS: 36 sidebar UI scenarios', '36 tests may pass', 'PASS: 36 files copied']) {
    assert.equal(overviewFor(entry('result', { output: text })).blocks[0].report, undefined);
  }
  const unknownBlock = [{ type: 'future_type', text: 'must retain kind' }];
  assert.ok(overviewFor(entry('result', { output: unknownBlock })).blocks[0].text.includes('future_type'));
  const noError = overviewFor(entry('tool', { command: 'test', error: false, exit_code: 0, output: 'ok' }));
  assert.equal(noError.lead.tone, 'success');
  assert.ok(!noError.blocks.some(b => b.error));
});
test('thinking summaries, context and unclassified records have distinct readable titles', () => {
  const thought = overviewFor(entry('summary', { type: 'reasoning' }, '**公开的推理摘要**'));
  assert.equal(thought.title, '思考摘要');
  assert.equal(thought.blocks[0].title, '思考摘要');
  assert.equal(thought.blocks[0].text, '**公开的推理摘要**');
  assert.equal(thought.blocks[0].format, 'markdown');
  const context = overviewFor(entry('context', { type: 'additional_tools', tools: [] }));
  assert.equal(context.title, '上下文记录');
  assert.ok(context.blocks[0].text.includes('additional_tools'));
  assert.equal(overviewFor(entry('record', { type: 'future_event' })).title, '其他记录');
});
console.log(`PASS: ${tests} Inspector presentation-model tests`);
