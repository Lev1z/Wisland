const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { chromium } = require('../target/tray-qa-tools/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 740 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setContent(fs.readFileSync('settings.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, ''));
    await page.addStyleTag({ content: fs.readFileSync('src/settings.css', 'utf8') });
    await page.evaluate(() => {
      document.getElementById('settings-shell').classList.add('menu-open');
      // Layout fixtures use the same element classes as the settings renderer.
      for (const id of ['left-visual-options', 'right-visual-options']) {
        for (const name of [id.startsWith('left') ? '额度环' : '状态灯', '猫猫挥手', '小狗奔跑']) {
          const button = document.createElement('button');
          button.className = 'visual-option';
          const preview = document.createElement('span'); preview.className = 'visual-native-preview'; preview.textContent = '•';
          const label = document.createElement('strong'); label.textContent = name;
          button.append(preview, label); document.getElementById(id).append(button);
        }
      }
      const orderRow = document.createElement('div'); orderRow.className = 'order-row'; orderRow.textContent = '⠿　01　主页';
      document.getElementById('icon-order-list').append(orderRow);
      window.commands = [];
      window.fixture = { enabled: true, active_app_id: 'cloudmusic.exe', min_ms: -3000, max_ms: 3000, step_ms: 500,
        players: [{app_id:'cloudmusic.exe',ms:0},{app_id:'microsoft.zunemusic_123!microsoft.zunemusic',ms:3000},{app_id:'unknown-player.exe',ms:-3000}] };
      window.module = { exports: {} }; window.exports = window.module.exports;
      window.require = () => ({ listen: async () => () => {}, invoke: async (command, args) => {
        window.commands.push({command,args});
        return command === 'get_lyric_offset_players' ? structuredClone(window.fixture) : args?.ms;
      } });
    });
    await page.addScriptTag({ content: ts.transpileModule(fs.readFileSync('src/settings-lyric-offset.ts','utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText });
    await page.evaluate(() => window.module.exports.initLyricOffset());
    await page.waitForFunction(() => document.querySelectorAll('#lyric-offset-list > div').length === 3);
    for (const size of [{width:760,height:500},{width:960,height:740},{width:1440,height:900}]) {
      await page.setViewportSize(size);
      for (const name of ['general','music','codex','obsidian','custom','behavior','about']) {
        await page.evaluate(name => {
          document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
          document.getElementById(`page-${name}`).classList.add('active');
        }, name);
        assert.ok(await page.locator('.content-body').evaluate(e => e.scrollWidth <= e.clientWidth), `${name} stays within content at ${size.width}`);
        if (name === 'general' || name === 'custom') {
          const selectors = name === 'general' ? ['#icon-order-list'] : ['#left-visual-options', '#right-visual-options', '#border-effect-options'];
          for (const selector of selectors) {
            const gap = await page.locator(selector).evaluate(e => e.firstElementChild.getBoundingClientRect().top - e.previousElementSibling.getBoundingClientRect().bottom);
            assert.ok(Math.abs(gap - 14) < 1, `${selector} has 14px below its divider, got ${gap}`);
          }
        }
        if (name === 'custom') {
          const widths = await page.evaluate(() => ['left-visual-options','right-visual-options','border-effect-options'].map(id => {
            const el = document.getElementById(id);
            return [el.firstElementChild.getBoundingClientRect().width, getComputedStyle(el).gridTemplateColumns];
          }));
          const tracks = widths.map(w => w[1].split(' ').map(parseFloat));
          assert.ok(widths.every((w,i) => Math.abs(w[0] - widths[0][0]) < 1 && tracks[i].length === tracks[0].length
            && tracks[i].every((n,j) => Math.abs(n - tracks[0][j]) < 1)), `visual and border cards share track widths and wrap rules: ${JSON.stringify(widths)}`);
        }
      }
    }
    await page.evaluate(() => {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-custom').classList.add('active');
      document.getElementById('page-title').textContent = '自定义';
      document.getElementById('page-description').textContent = '左右动图与动态边框方案。';
      document.querySelectorAll('.nav-item').forEach(e => e.classList.toggle('active', e.dataset.page === 'custom'));
    });
    await page.waitForTimeout(700);
    await page.screenshot({path:'target/settings-card-spacing-qa.png'});
    assert.equal(await page.locator('#icon-bar-style option[value="option-wheel"]').textContent(), '滚轮菜单');
    assert.equal(await page.locator('#log-level option[value="info"]').textContent(), '信息');
    assert.equal(await page.locator('#clear-codex-status').textContent(), '重置任务状态');
    assert.equal(await page.locator('#run-environment-check').getAttribute('class'), 'secondary-button compact');
    assert.equal(await page.locator('#page-custom small').count(), 0);
    await page.evaluate(() => {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-music').classList.add('active');
      document.getElementById('page-title').textContent = '音乐';
      document.getElementById('page-description').textContent = '歌词校准与播放器。';
      document.querySelectorAll('.nav-item').forEach(e => e.classList.toggle('active', e.dataset.page === 'music'));
    });
    const rows = page.locator('#lyric-offset-list > div');
    assert.ok((await rows.nth(0).textContent()).includes('网易云音乐'));
    assert.equal(await rows.nth(0).locator('span[title]').getAttribute('title'), 'cloudmusic.exe');
    assert.ok((await rows.nth(1).textContent()).includes('Windows 媒体播放器'));
    assert.ok((await rows.nth(2).textContent()).includes('unknown-player.exe'));
    assert.equal(await rows.nth(1).getByRole('button', {name:'+ 0.5 秒', exact:true}).isDisabled(), true);
    assert.equal(await rows.nth(2).getByRole('button', {name:'− 0.5 秒', exact:true}).isDisabled(), true);
    await rows.nth(0).getByRole('button', {name:'+ 0.5 秒', exact:true}).click();
    await page.waitForFunction(() => window.commands.some(c => c.command === 'set_lyric_offset_for_player'));
    assert.deepEqual(await page.evaluate(() => window.commands.find(c => c.command === 'set_lyric_offset_for_player').args), {appId:'cloudmusic.exe',ms:500});
    await rows.nth(0).getByRole('button', {name:'移除', exact:true}).click();
    await page.waitForFunction(() => document.querySelectorAll('#lyric-offset-list > div').length === 2);
    assert.deepEqual(await page.evaluate(() => window.commands.find(c => c.command === 'delete_lyric_offset_player').args), {appId:'cloudmusic.exe'});
    await page.setViewportSize({width:960,height:740});
    await page.waitForTimeout(700);
    await page.screenshot({path:'target/settings-simplified-qa.png'});
    assert.deepEqual(errors, []);
    console.log('PASS: 7 settings pages at 3 sizes / divider spacing / matching card tracks / stable option values / friendly player names / raw ID tooltips / offset boundaries, saving and removal');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
