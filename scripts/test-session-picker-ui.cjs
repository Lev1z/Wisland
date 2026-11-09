const assert = require('node:assert/strict');
const path = require('node:path');
exports.checkSessionHierarchy = async function checkSessionHierarchy(page, { theme, scale, output }) {
  await page.evaluate(() => {
    window.qaHierarchySessions = structuredClone(window.qaRuntime.sessions);
    const session = (id, label, parent = null) => ({ id, label, forkedFromId: parent, modified: 1 });
    window.qaRuntime.sessions = [
      session('test-session', '安装 Wisland 项目'), session('wisland-branch', '安装 Wisland 项目', 'test-session'),
      // Newest first in the catalog: the descendant can precede its own root.
      session('01a1b00f', 'master', '01a17ae3'), session('01a17ae3', 'master', 'archived-parent'),
      session('grandchild', 'master', '01a1b00f'), session('other-root', 'master'),
      ...Array.from({ length: 12 }, (_, i) => session(`deep-${i}`, 'deep fork', i ? `deep-${i - 1}` : 'grandchild')),
    ];
    window.qaRuntime.revision++; window.qaEmit('runtime-snapshot', structuredClone(window.qaRuntime));
  });
  await page.locator('#runtime-session').click();
  const rows = page.locator('.session-option');
  const order = await rows.evaluateAll(items => items.map(item => ({ id: item.dataset.value, depth: Number(item.dataset.depth), text: item.textContent })));
  assert.deepEqual(order.slice(0, 6), [
    { id: '', depth: 0, text: '自动跟随' }, { id: 'test-session', depth: 0, text: '安装 Wisland 项目' },
    { id: 'wisland-branch', depth: 1, text: '分支 · wisland-' }, { id: '01a17ae3', depth: 0, text: 'master' },
    { id: '01a1b00f', depth: 1, text: '分支 · 01a1b00f' }, { id: 'grandchild', depth: 2, text: '分支 · grandchi' },
  ]);
  assert.equal(order.filter(row => row.text === 'master' && row.depth === 0).length, 2, 'same-named independent roots are not merged');
  const geometry = await rows.evaluateAll(items => Object.fromEntries(items.map(item => {
    const r = item.getBoundingClientRect(); return [item.dataset.value, { left: r.left, right: r.right, height: r.height }];
  })));
  assert.equal(geometry['01a17ae3'].left, geometry['test-session'].left, 'orphan master starts a separate root group');
  assert.equal(geometry['01a1b00f'].left - geometry['01a17ae3'].left, 22);
  assert.equal(geometry.grandchild.left - geometry['01a1b00f'].left, 16, 'nested branches no longer share one flat indentation');
  assert.equal(geometry['deep-11'].left, geometry['deep-10'].left, 'deep visual indent is bounded');
  assert.equal(await page.locator('.session-option[data-value="deep-11"]').getAttribute('data-depth'), '14', 'full logical depth remains available');
  assert.ok(Object.values(geometry).every(r => r.height === 26 && r.right === geometry['test-session'].right));
  assert.ok(await page.locator('#runtime-sessions').evaluate(e => e.scrollWidth <= e.clientWidth && e.getBoundingClientRect().right <= innerWidth));
  if (scale === 1.25) {
    await page.evaluate(theme => window.qaEmit('tray-appearance', { acrylic: true, dark: theme === 'dark', motion: true }), theme);
    await page.locator('body').evaluate((e, color) => e.style.backgroundColor = color, theme === 'dark' ? '#353535' : '#f3f3f3');
    await page.screenshot({ path: path.join(output, `session-picker-hierarchy-${theme}.png`) });
    await page.locator('body').evaluate(e => e.style.backgroundColor = '');
    await page.evaluate(theme => window.qaEmit('tray-appearance', { acrylic: false, dark: theme === 'dark', motion: true }), theme);
  }
  await page.locator('.session-option[data-value="01a17ae3"]').click();
  await page.waitForFunction(() => window.qaRuntime.sessionId === '01a17ae3');
  assert.equal(await page.locator('#runtime-session-label').textContent(), 'master', 'closed picker uses the same visible-root name');
  assert.ok(await page.evaluate(() => window.qaCommands.some(c => c.command === 'select_runtime_session' && c.args.id === '01a17ae3')), 'selection keeps the real thread ID');
  await page.locator('#runtime-session').click();
  // Simulate a formerly omitted parent re-entering the recent/pinned catalog.
  await page.evaluate(() => {
    window.qaRuntime.sessions.push({ id: 'archived-parent', label: '原父会话', modified: 1 });
    window.qaRuntime.revision++; window.qaEmit('runtime-snapshot', structuredClone(window.qaRuntime));
  });
  await page.waitForFunction(() => document.querySelector('.session-option[data-value="01a17ae3"]').dataset.depth === '1');
  assert.equal(await page.locator('.session-option[data-value="01a1b00f"]').getAttribute('data-depth'), '2');
  assert.equal(await page.locator('#runtime-session-label').textContent(), '分支 · 01a17ae3');
  await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.qaRuntime.automatic === true);
  await page.evaluate(() => {
    window.qaRuntime.sessions = window.qaHierarchySessions;
    window.qaRuntime.revision++; window.qaEmit('runtime-snapshot', structuredClone(window.qaRuntime));
  });
};
