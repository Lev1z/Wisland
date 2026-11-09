const assert = require('node:assert/strict');
const path = require('node:path');

exports.checkModelHeaders = async function (page, { theme, scale, output }) {
  await page.evaluate(() => {
    window.qaModelSaved = structuredClone(window.qaRuntime.events);
    const event = window.qaRuntime.events.find(e => e.id === '7');
    Object.assign(event, { kind: 'model', modelCall: null, status: 'awaiting_association',
      summary: '输出待关联 · 尚未确定模型请求',
      modelPresentation: { association: 'pending', purpose: '输出待关联', anchorId: '8' } });
    window.qaDetailOverride = { event: structuredClone(event), detail: { raw: { type: 'wisland_model_header', payload: {} }, content: '', byteOffset: 0 }, related: [] };
    window.qaRuntime.revision++; window.qaEmit('runtime-snapshot', structuredClone(window.qaRuntime));
  });
  await page.locator('#trajectory-list').evaluate(e => e.scrollTop = 100);
  await page.waitForTimeout(40);
  await page.locator('.event-row[data-event="7"]').dispatchEvent('click');
  await page.waitForFunction(() => document.getElementById('inspector').dataset.phase === 'open' && document.getElementById('inspector-title').textContent.includes('待关联'));
  assert.ok((await page.locator('#inspector-content').textContent()).includes('不计入模型请求编号'));
  const before = await page.evaluate(() => {
    window.qaModelRow = document.querySelector('.event-row[data-event="7"]');
    return document.querySelector('.event-row[data-event="9"]').getBoundingClientRect().y;
  });
  await page.evaluate(() => {
    const event = window.qaRuntime.events.find(e => e.id === '7');
    Object.assign(event, { modelCall: { responseId: 'observed-response', number: 4 }, status: 'usage_recorded',
      summary: '#4 · 工具调用 · 已记录用量', modelPresentation: { association: 'sequence', purpose: '工具调用', anchorId: '8' } });
    window.qaDetailOverride = { event: structuredClone(event), detail: {
      raw: { type: 'token_usage_record', payload: { response_id: 'observed-response', usage: { total_tokens: 24 } } },
      content: '已记录用量', byteOffset: 42, modelAssociation: { method: 'sequence', sourceEventId: 'source-42' },
    }, related: [] };
    // A newly resolved earlier title must not move the reader's visual anchor.
    window.qaRuntime.events.unshift({ ...event, id: 'earlier-heading', modelCall: null });
    window.qaRuntime.revision++; window.qaEmit('runtime-snapshot', structuredClone(window.qaRuntime));
  });
  await page.waitForFunction(() => document.getElementById('inspector-title').textContent === '模型 #4 · 工具调用');
  assert.equal(await page.evaluate(() => window.qaModelRow === document.querySelector('.event-row[data-event="7"]')), true);
  assert.equal(await page.locator('.event-row[data-event="7"]').getAttribute('aria-current'), 'true');
  const overview = await page.locator('#inspector-content').textContent();
  assert.ok(overview.includes('已记录用量') && overview.includes('顺序推断'));
  assert.ok(!overview.includes('已完成') && !overview.includes('耗时'));
  assert.ok(Math.abs((await page.locator('.event-row[data-event="9"]').boundingBox()).y - before) < 2);
  assert.ok((await page.locator('.event-row[data-event="7"] .request-marker').getAttribute('title')).includes('不代表请求开始时间'));
  if (scale === 1.25) await page.screenshot({ path: path.join(output, `model-heading-${theme}.png`) });
  await page.locator('#tab-raw').click();
  assert.ok((await page.locator('[data-section="raw"] pre').textContent()).includes('token_usage_record'));
  await page.keyboard.press('Escape'); await page.locator('#inspector').waitFor({ state: 'hidden' });
  assert.ok(Math.abs((await page.locator('.event-row[data-event="9"]').boundingBox()).y - before) < 2, 'close restores the anchor after a heading insertion');
  await page.evaluate(() => {
    window.qaRuntime.events = window.qaModelSaved; delete window.qaDetailOverride;
    window.qaRuntime.revision++; window.qaEmit('runtime-snapshot', structuredClone(window.qaRuntime));
  });
};
