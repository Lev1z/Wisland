const assert = require('node:assert/strict');
const path = require('node:path');

// Used by the six theme/DPI combinations in test-tray-ui.cjs. Fixtures model
// actual IPC shapes; all clipboard/network probes are isolated to this page.
exports.checkInspector = async function checkInspector(page, { theme, scale, output }) {
  const requests = [];
  const onRequest = request => { if (!request.url().startsWith('http://127.0.0.1:')) requests.push(request.url()); };
  page.on('request', onRequest);
  await page.evaluate(() => {
    window.qaSavedEvent = structuredClone(window.qaRuntime.events.find(e => e.id === '7'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.qaCopied = value; } } });
  });
  async function show(kind, payload, content, extra = {}) {
    await page.evaluate(({ kind, payload, content, extra }) => {
      const event = window.qaRuntime.events.find(e => e.id === '7');
      Object.assign(event, window.qaSavedEvent, { kind, summary: 'Inspector fixture' }, extra.event ?? {});
      window.qaDetailOverride = { event: structuredClone(event), detail: { content, byteOffset: 123, raw: { type: 'response_item', payload }, ...extra.data }, related: extra.related ?? [] };
      window.qaRuntime.revision++;
      window.qaEmit('runtime-snapshot', structuredClone(window.qaRuntime));
    }, { kind, payload, content, extra });
    await page.locator('.event-row[data-event="7"]').dispatchEvent('click');
    await page.waitForFunction(() => document.getElementById('inspector').dataset.phase === 'open' && document.getElementById('inspector-content').textContent !== '正在读取…');
    await page.locator('#tab-overview').click();
  }
  const prose = '# 实现方案\n\n**先验证，再提交。**\n\n- 解析消息\n- 保留原始数据\n\n> 仅展示实际记录\n\n```ts\nconst path = "C:\\new";\n```\n\n| 项目 | 结果 |\n| --- | --- |\n| 测试 | 通过 |\n\n<script>window.qaXss=true</script>\n<img src="https://inspector.invalid/leak" onerror="window.qaXss=true">\n\n![远程图片](https://inspector.invalid/image)\n[恶意链接](javascript:window.qaXss=true)\n[文件](file:///C:/private)';
  await show('assistant', { type: 'message', content: prose }, prose, { data: { mirror: { payload: { content: 'MIRROR_SENTINEL\n' + '另一条源记录\n'.repeat(80) } } } });
  assert.equal(await page.locator('.detail-prose h1').textContent(), '实现方案');
  assert.equal(await page.locator('.detail-prose strong').textContent(), '先验证，再提交。');
  assert.equal(await page.locator('.detail-prose ul li').count(), 2);
  assert.equal(await page.locator('.detail-prose table').count(), 1);
  assert.equal(await page.locator('.detail-prose').evaluate(e => getComputedStyle(e).fontSize), '13px');
  assert.equal(await page.locator('.detail-prose pre').evaluate(e => getComputedStyle(e).fontSize), '12px');
  assert.equal(await page.locator('#inspector-content img, #inspector-content script, #inspector-content a, #inspector-content iframe, #inspector-content [src], #inspector-content [href], #inspector-content [onerror]').count(), 0);
  assert.equal(await page.evaluate(() => window.qaXss), undefined);
  assert.ok(!(await page.locator('#inspector-content').textContent()).includes('MIRROR_SENTINEL'));
  assert.equal(await page.locator('[data-section="technical"]').getAttribute('open'), null);
  await page.locator('[data-section="message"] .detail-action').first().click();
  assert.equal(await page.evaluate(() => window.qaCopied), prose, 'copy preserves Markdown source');
  await page.locator('#tab-raw').click();
  assert.ok((await page.locator('#inspector-content').textContent()).includes('MIRROR_SENTINEL'));
  for (const id of ['raw', 'mirror']) {
    const section = page.locator(`[data-section="${id}"]`);
    assert.equal(await section.getAttribute('data-expanded'), 'true', 'raw records default to expanded');
    assert.ok(await section.locator('.detail-preview').evaluate(e => e.clientHeight > 240 && e.scrollHeight <= e.clientHeight + 1), 'raw records are not clipped at the overview preview height');
  }
  await page.locator('[data-section="raw"] .detail-expand').click();
  await page.evaluate(() => {
    window.qaDetailOverride.detail.raw.payload.phase = 'final';
    window.qaRuntime.revision++; window.qaEmit('runtime-snapshot', structuredClone(window.qaRuntime));
  });
  await page.waitForFunction(() => document.querySelector('[data-section="raw"] pre').textContent.includes('"phase": "final"'));
  assert.equal(await page.locator('[data-section="raw"]').getAttribute('data-expanded'), 'false', 'explicit collapse survives a live update');
  await page.locator('#tab-overview').click();
  await page.locator('#tab-raw').click();
  assert.equal(await page.locator('[data-section="raw"]').getAttribute('data-expanded'), 'true', 'reopening the raw tab restores expanded default');
  await page.locator('#tab-overview').click();
  const longText = '命令输出行\n'.repeat(300) + 'END_OF_RETAINED_TEXT… [已截断]';
  const tool = { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm run test\nnode scripts/check.cjs', workdir: 'D:\\Code', max_output_tokens: 1000 }) };
  const related = [{ event: { ...await page.evaluate(() => window.qaSavedEvent), id: 'result-1', kind: 'result', status: null }, detail: { byteOffset: 222, raw: { payload: { item: { type: 'FunctionCallOutput', output: JSON.stringify({ output: longText, exit_code: 1, wall_time_seconds: 0.9 }) } } }, content: longText } }];
  await show('tool', tool, 'exec_command ' + tool.arguments, { related });
  assert.equal(await page.locator('#inspector-title').textContent(), '执行命令');
  assert.equal((await page.locator('#inspector-content').textContent()).split('npm run test').length - 1, 1, 'command is not duplicated');
  assert.equal(await page.locator('[data-section="command"] pre').textContent(), 'npm run test\nnode scripts/check.cjs');
  assert.equal(await page.locator('[data-section="params"]').getAttribute('open'), null);
  assert.ok((await page.locator('[data-section="related-result-1"] .detail-facts').textContent()).includes('退出码1'));
  assert.equal(await page.locator('.detail-facts [data-tone="error"]').textContent(), '1');
  const preview = page.locator('[data-section="related-result-1"]');
  await preview.locator('.detail-expand').waitFor({ state: 'visible' });
  assert.ok(await preview.locator('.detail-preview').evaluate(e => e.clientHeight <= 240 && e.scrollHeight > e.clientHeight));
  await preview.locator('.detail-expand').click();
  assert.ok(await preview.locator('.detail-preview').evaluate(e => e.clientHeight > 240));
  assert.ok((await preview.textContent()).includes('END_OF_RETAINED_TEXT… [已截断]'));
  await page.locator('[data-section="technical"] summary').click();
  await page.locator('#inspector-content').evaluate(e => e.scrollTop = 180);
  const readerScroll = await page.locator('#inspector-content').evaluate(e => e.scrollTop);
  await page.evaluate(() => {
    window.qaDetailOverride.detail.raw.payload.status = 'completed';
    window.qaRuntime.revision++; window.qaEmit('runtime-snapshot', structuredClone(window.qaRuntime));
  });
  await page.waitForFunction(() => document.querySelector('#inspector-content > .detail-lead')?.textContent.includes('执行已结束'));
  assert.equal(await preview.getAttribute('data-expanded'), 'true', 'live update keeps expanded preview');
  assert.notEqual(await page.locator('[data-section="technical"]').getAttribute('open'), null, 'live update keeps technical section open');
  assert.equal(await page.locator('#inspector-content').evaluate(e => e.scrollTop), readerScroll, 'live update keeps detail scroll');
  await preview.locator('.detail-expand').click();
  await page.locator('#inspector-content').evaluate(e => e.scrollTop = 0);
  if (scale === 1.25) await page.screenshot({ path: path.join(output, `inspector-tool-${theme}.png`) });
  // Known execution wrappers, nonzero errors and related input are structured.
  await show('result', { output: JSON.stringify({ output: 'Assertion failed: expected 2, received 3', exit_code: 1, wall_time_seconds: 0.125 }) }, 'duplicate result', { related: [{ event: { ...related[0].event, kind: 'tool' }, detail: { byteOffset: 1, raw: { payload: { item: tool } }, content: 'duplicate command' } }] });
  assert.equal((await page.locator('#inspector-content').textContent()).split('Assertion failed').length - 1, 1);
  assert.equal(await page.locator('.detail-facts [data-tone="error"]').textContent(), '1');
  assert.equal(await page.locator('details[data-section$="command"]').getAttribute('open'), null);
  // Secondary details have ONE disclosure, even when their contents exceed
  // the primary overview's 240px preview. Exercise both tool input shapes.
  for (const command of [true, false]) {
    const input = '关联工具完整内容\n'.repeat(90) + 'RELATED_END';
    const payload = command ? { name: 'exec_command', arguments: JSON.stringify({ cmd: input }) } : { name: 'apply_patch', input };
    await show('result', { output: 'done' }, 'done', {
      event: { callId: 'metadata-'.repeat(100) },
      related: [{ event: { ...related[0].event, kind: 'tool' }, detail: { byteOffset: 1, raw: { payload }, content: input } }],
    });
    const linked = page.locator(`details[data-section$="${command ? 'command' : 'input'}"]`);
    const technical = page.locator('[data-section="technical"]');
    for (const disclosure of [linked, technical]) {
      assert.equal(await disclosure.getAttribute('open'), null, 'secondary details start folded');
      assert.equal(await disclosure.locator('.detail-expand').count(), 0, 'no nested expand-all control');
      await disclosure.locator('summary').click();
      assert.ok(await disclosure.locator('.detail-preview').evaluate(e => e.clientHeight > 240 && e.scrollHeight <= e.clientHeight + 1 && getComputedStyle(e).maxHeight === 'none'), 'one click reveals all retained content');
    }
    await linked.locator('summary').focus();
    await page.evaluate(() => {
      window.qaDetailOverride.detail.raw.payload.status = 'completed';
      window.qaRuntime.revision++; window.qaEmit('runtime-snapshot', structuredClone(window.qaRuntime));
    });
    await page.waitForFunction(() => document.querySelector('#inspector-content > .detail-facts')?.textContent.includes('已完成'));
    assert.notEqual(await linked.getAttribute('open'), null, 'live refresh preserves the outer disclosure');
    assert.notEqual(await technical.getAttribute('open'), null);
    assert.ok(await linked.locator('summary').evaluate(e => e === document.activeElement), 'refresh preserves disclosure keyboard focus');
    await page.keyboard.press('Enter');
    assert.equal(await linked.getAttribute('open'), null, 'summary remains the one close control');
    await page.keyboard.press('Enter');
    assert.ok(await linked.locator('.detail-preview').evaluate(e => e.scrollHeight <= e.clientHeight + 1), 'reopening remains fully expanded');
    await linked.locator('.detail-action').click();
    assert.equal(await page.evaluate(() => window.qaCopied), input, 'copy still includes all retained content');
  }
  await show('tool', { name: 'apply_patch', input: '*** Begin Patch\n+const p = "C:\\new";\n*** End Patch' }, 'duplicate');
  assert.ok((await page.locator('[data-section="input"] pre').textContent()).includes('C:\\new'));
  await show('tool', { name: 'broken_json', arguments: '{"cmd":"unfinished… [已截断]' }, 'duplicate');
  assert.equal(await page.locator('[data-section="input"] pre').textContent(), '{"cmd":"unfinished… [已截断]');
  await show('model', { model: 'recorded-model', token_usage: { input_tokens: 120, output_tokens: 24, total_tokens: 144 } }, 'call completed', { event: { status: 'completed', modelCall: { number: 3, responseId: 'r3' } } });
  assert.equal(await page.locator('#inspector-title').textContent(), '模型调用 #3');
  assert.ok((await page.locator('.detail-facts').textContent()).includes('输入 token120'));
  assert.ok(!(await page.locator('.detail-facts').textContent()).includes('耗时'));
  await show('record', { type: 'future_event', unexpected_field: '保留未知信息', very_long: 'x'.repeat(1800) }, 'future_event');
  assert.equal(await page.locator('#inspector-title').textContent(), '其他记录');
  assert.ok((await page.locator('[data-section="record"]').textContent()).includes('unexpected_field'));
  assert.ok(await page.locator('#inspector-content').evaluate(e => e.scrollWidth <= e.clientWidth), 'long fields wrap within Inspector');
  await show('context', { type: 'additional_tools', tools: [{ name: 'exec_command' }] }, '上下文工具更新');
  assert.equal(await page.locator('#inspector-title').textContent(), '上下文 · 工具更新');
  const contextBadge = page.locator('.event-row[data-event="7"] .event-kind');
  assert.equal(await contextBadge.textContent(), '上下文');
  assert.ok(await contextBadge.evaluate(e => e.scrollWidth <= e.clientWidth && e.getBoundingClientRect().right < document.getElementById('inspector').getBoundingClientRect().left), 'three-character context badge fits and stays exposed beside Inspector');
  if (scale === 1.25) await page.screenshot({ path: path.join(output, `inspector-context-label-${theme}.png`) });
  await show('summary', { type: 'reasoning', summary: [{ text: '公开的推理摘要' }] }, '**公开的推理摘要**');
  assert.equal(await page.locator('#inspector-title').textContent(), '思考摘要');
  assert.equal(await page.locator('.event-row[data-event="7"] .event-kind').textContent(), '思考');
  assert.ok((await page.locator('.event-row[data-event="7"] .event-kind').getAttribute('title')).includes('公开'));
  assert.equal(await page.locator('[data-section="message"] strong').textContent(), '公开的推理摘要');
  await show('lifecycle', { type: 'task_started' }, '回合开始');
  assert.equal(await page.locator('#inspector-title').textContent(), '本轮已开始');
  assert.equal(await page.locator('.detail-lead').count(), 0, 'turn start no longer adds the explanatory banner');
  const argv = ['C:\\Program Files\\WindowsApps\\OpenAI.CodexPrimaryRuntime\\pwsh.exe', '-NoProfile', '-Command', 'node scripts/test-tray-ui.cjs'];
  await show('tool', { type: 'item_completed', item: { type: 'CommandExecution', command: argv, status: 'completed', exit_code: 0, duration_ms: 107582,
    aggregated_output: 'PASS: 36 sidebar UI scenarios (6 quota states × 2 themes × 3 DPI scales)\nScreenshots: D:\\Code\\PROJECTS\\Wisland\\target\\tray-ui-qa' } }, 'raw command');
  assert.equal(await page.locator('#inspector-title').textContent(), '执行命令');
  assert.equal(await page.locator('.detail-lead').textContent(), '进程正常退出');
  assert.equal(await page.locator('[data-section="command"] pre').textContent(), argv.at(-1));
  assert.equal(await page.locator('.detail-report').textContent(), '输出报告：36 组界面测试通过');
  assert.ok(!(await page.locator('#inspector-content').innerText()).includes('WindowsApps'), 'launcher plumbing stays out of the initial overview');
  assert.ok((await page.locator('.detail-facts').textContent()).includes('1 分 47.6 秒'));
  await page.locator('[data-section="command"] .detail-action').first().click();
  assert.equal(await page.evaluate(() => window.qaCopied), argv.at(-1));
  if (scale === 1.25) await page.screenshot({ path: path.join(output, `inspector-command-readable-${theme}.png`) });
  await page.locator('#tab-raw').click();
  assert.ok((await page.locator('[data-section="raw"] pre').textContent()).includes('WindowsApps'));
  const batch = 'Script completed\nWall time 5.1 seconds\nOutput:\n' + [
    { chunk_id: 'first', wall_time_seconds: 4.27, exit_code: 0, output: 'PASS: 36 sidebar UI scenarios, all passed\nC:\\new\\test' },
    { chunk_id: 'second', wall_time_seconds: 0.59, exit_code: 2, output: 'Unable to read history\n<script>window.qaXss=true</script>\n<img src="https://inspector.invalid/leak">' },
  ].map(value => JSON.stringify(value)).join('\n');
  await show('result', { output: batch }, batch);
  assert.equal(await page.locator('#inspector-title').textContent(), '批量调用结果');
  assert.ok((await page.locator('.detail-lead').textContent()).includes('1 条异常'));
  assert.equal(await page.locator('.detail-outcome').count(), 2);
  assert.equal(await page.locator('[data-section="output-return-2"] .detail-outcome').getAttribute('data-tone'), 'error');
  assert.equal(await page.locator('[data-section="output-return-1"] pre').textContent(), 'PASS: 36 sidebar UI scenarios, all passed\nC:\\new\\test');
  assert.ok(!(await page.locator('#inspector-content').innerText()).includes('chunk_id'));
  assert.equal(await page.locator('#inspector-content script, #inspector-content img').count(), 0);
  await page.locator('[data-section="output-return-1"] .detail-action').first().click();
  assert.equal(await page.evaluate(() => window.qaCopied), 'PASS: 36 sidebar UI scenarios, all passed\nC:\\new\\test');
  if (scale === 1.25) await page.screenshot({ path: path.join(output, `inspector-batch-readable-${theme}.png`) });
  const reply = '**已完成并提交** `71f1044`。\n\n- Inspector 完整展开\n- 托盘再次点击收起\n\n[下载测试版](D:/Code/PROJECTS/Wisland/target/test.exe)';
  await show('lifecycle', { type: 'task_complete', duration_ms: 560760, time_to_first_token_ms: 3560, last_agent_message: reply, root_turn_id: 'ROOT_SENTINEL' }, '回合结束');
  assert.equal(await page.locator('#inspector-title').textContent(), '本轮已结束');
  assert.ok((await page.locator('.detail-facts').textContent()).includes('本轮耗时9 分 20.8 秒'));
  assert.ok((await page.locator('.detail-facts').textContent()).includes('本轮首 token3.56 秒'));
  assert.equal(await page.locator('[data-section="final-message"] strong').textContent(), '已完成并提交');
  assert.equal(await page.locator('[data-section="final-message"] li').count(), 2);
  assert.ok(!(await page.locator('#inspector-content').innerText()).includes('ROOT_SENTINEL'));
  await page.locator('[data-section="final-message"] .detail-action').first().click();
  assert.equal(await page.evaluate(() => window.qaCopied), reply);
  assert.equal(await page.locator('#inspector-content a').count(), 0);
  if (scale === 1.25) await page.screenshot({ path: path.join(output, `inspector-turn-readable-${theme}.png`) });
  await page.locator('#tab-raw').click();
  assert.ok((await page.locator('[data-section="raw"] pre').textContent()).includes('last_agent_message'));
  assert.equal(await page.locator('[data-section="raw"]').getAttribute('data-expanded'), 'true');
  const rules = '# 项目规则\n\n## 表达规范\n\n- 直接陈述观点\n- 保留事实依据\n\n![图片](https://inspector.invalid/context)';
  await show('context', { full: false, state: { agents_md: { text: rules }, cwd: 'D:\\Code', unknown: 'CONTEXT_EXTRA' } }, '', { event: { sourceType: 'world_state.' } });
  assert.equal(await page.locator('[data-section="context-rules"] h1').textContent(), '项目规则');
  assert.ok((await page.locator('.detail-facts').innerText()).includes('增量更新'));
  assert.equal(await page.locator('[data-section="context-state"]').getAttribute('open'), null);
  assert.ok(!(await page.locator('#inspector-content').innerText()).includes('CONTEXT_EXTRA'));
  await page.locator('[data-section="context-rules"] .detail-action').first().click();
  assert.equal(await page.evaluate(() => window.qaCopied), rules);
  if (scale === 1.25) await page.screenshot({ path: path.join(output, `inspector-context-readable-${theme}.png`) });
  await page.locator('#tab-raw').click();
  assert.ok((await page.locator('[data-section="raw"] pre').textContent()).includes('agents_md'));
  const history = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '## 保留的任务\n\n继续完善项目。' }] }];
  await show('compaction', { message: '', compaction_response_id: 'COMPACT_ID', replacement_history: history, latest_token_usage_record: { usage: { total_tokens: 120 } } }, '', { event: { sourceType: 'compacted.compacted' } });
  assert.ok((await page.locator('.detail-lead').textContent()).includes('未附带'));
  assert.equal(await page.locator('[data-section="history-0"] h2').textContent(), '保留的任务');
  assert.equal(await page.locator('[data-section="compaction-usage"]').getAttribute('open'), null);
  assert.ok(!(await page.locator('#inspector-content').innerText()).includes('COMPACT_ID'));
  if (scale === 1.25) await page.screenshot({ path: path.join(output, `inspector-compaction-history-${theme}.png`) });
  await show('compaction', { message: '# 压缩摘要\n\n- 已完成规则展示\n- 下一步验证界面', replacement_history: history }, '', { event: { sourceType: 'compacted.compacted' } });
  assert.equal(await page.locator('[data-section="compaction-summary"] li').count(), 2);
  assert.equal(await page.locator('[data-section="history-0"]').getAttribute('open'), null);
  await page.locator('[data-section="history-0"] summary').click();
  assert.ok(await page.locator('[data-section="history-0"] h2').isVisible());
  assert.equal(await page.locator('[data-section="history-0"] .detail-expand').count(), 0);
  await page.locator('#tab-raw').click();
  assert.ok((await page.locator('[data-section="raw"] pre').textContent()).includes('replacement_history'));
  await page.locator('#tab-overview').click();
  if (scale === 1.25) await page.screenshot({ path: path.join(output, `inspector-compaction-readable-${theme}.png`) });
  assert.equal(await page.locator('#inspector-content img, #inspector-content script').count(), 0);
  await show('assistant', { type: 'message' }, '# 验证结果\n\n**布局已更新。**\n\n- 命令和结果分别呈现\n- 关键状态前置\n- 技术信息默认折叠\n\n```ts\nconst readable = true;\n```\n\n| 检查 | 结果 |\n| --- | --- |\n| 窄栏排版 | 通过 |');
  if (scale === 1.25) await page.screenshot({ path: path.join(output, `inspector-message-${theme}.png`) });
  await page.setViewportSize({ width: 525, height: 360 });
  assert.ok(await page.locator('#inspector-content').evaluate(e => e.clientHeight > 0 && e.scrollWidth <= e.clientWidth));
  await page.setViewportSize({ width: 525, height: 850 });
  await page.keyboard.press('Escape'); await page.locator('#inspector').waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    Object.assign(window.qaRuntime.events.find(e => e.id === '7'), window.qaSavedEvent);
    delete window.qaDetailOverride;
    window.qaRuntime.revision++; window.qaEmit('runtime-snapshot', structuredClone(window.qaRuntime));
  });
  assert.deepEqual(requests, [], 'Markdown must not fetch remote resources');
  page.off('request', onRequest);
};
