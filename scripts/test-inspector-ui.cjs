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
  assert.equal(await page.locator('#inspector-title').textContent(), 'exec_command');
  assert.equal((await page.locator('#inspector-content').textContent()).split('npm run test').length - 1, 1, 'command is not duplicated');
  assert.equal(await page.locator('[data-section="command"] pre').textContent(), 'npm run test\nnode scripts/check.cjs');
  assert.equal(await page.locator('[data-section="params"]').getAttribute('open'), null);
  assert.ok((await page.locator('.detail-facts').textContent()).includes('退出码1'));
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
  await page.waitForFunction(() => document.querySelector('#inspector-content > .detail-facts')?.textContent.includes('已完成'));
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
  await show('tool', { name: 'apply_patch', input: '*** Begin Patch\n+const p = "C:\\new";\n*** End Patch' }, 'duplicate');
  assert.ok((await page.locator('[data-section="input"] pre').textContent()).includes('C:\\new'));
  await show('tool', { name: 'broken_json', arguments: '{"cmd":"unfinished… [已截断]' }, 'duplicate');
  assert.equal(await page.locator('[data-section="input"] pre').textContent(), '{"cmd":"unfinished… [已截断]');
  await show('model', { model: 'recorded-model', token_usage: { input_tokens: 120, output_tokens: 24, total_tokens: 144 } }, 'call completed', { event: { status: 'completed', modelCall: { number: 3, responseId: 'r3' } } });
  assert.equal(await page.locator('#inspector-title').textContent(), '模型调用 #3');
  assert.ok((await page.locator('.detail-facts').textContent()).includes('输入 token120'));
  assert.ok(!(await page.locator('.detail-facts').textContent()).includes('耗时'));
  await show('context', { type: 'future_event', unexpected_field: '保留未知信息', very_long: 'x'.repeat(1800) }, 'future_event');
  assert.ok((await page.locator('[data-section="record"]').textContent()).includes('unexpected_field'));
  assert.ok(await page.locator('#inspector-content').evaluate(e => e.scrollWidth <= e.clientWidth), 'long fields wrap within Inspector');
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
