const fs = require('node:fs');
const assert = require('node:assert/strict');
const ts = require('typescript');
const {chromium} = require('../target/tray-qa-tools/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  const code = ts.transpileModule(fs.readFileSync('src/theme.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  try {
    for (const [surface, html, styles] of [
      ['capsule','index.html',['public/themes/base.css','public/themes/classic.css']],
      ['settings','settings.html',['src/settings.css']],
      ['sidebar','tray.html',['src/tray.css']]
    ]) {
      const page = await browser.newPage({viewport:{width:960,height:740}});
      const errors = []; page.on('pageerror', e => errors.push(String(e)));
      await page.setContent(fs.readFileSync(html,'utf8').replace(/<script[\s\S]*?<\/script>/g,''));
      for (const style of [...styles,'src/theme.css']) await page.addStyleTag({content:fs.readFileSync(style,'utf8')});
      await page.evaluate(() => {
        window.commands=[]; window.fixture={theme:'dark',border_effect:'off'}; window.nativeAcrylic=true;
        window.module={exports:{}}; window.exports=window.module.exports;
        window.require = name => name.endsWith('.css') ? {} : {
          listen:async (_event, callback) => {window.themeChanged=callback;return ()=>{};},
          invoke:async (command,args) => {
            window.commands.push({command,args});
            if (command==='get_settings') return window.fixture;
            if (command==='get_window_theme') return {dark:true,motion:true,acrylic:window.nativeAcrylic && window.fixture.theme==='glass'};
          }
        };
        document.getElementById('settings-shell')?.classList.add('menu-open');
      });
      await page.addScriptTag({content:code});
      await page.evaluate(surface=>window.module.exports.initTheme(surface),surface);
      await page.waitForFunction(()=>document.documentElement.dataset.wislandTheme==='dark');
      const target = surface==='capsule' ? '#island-capsule' : surface==='sidebar' ? '.details' : 'body';
      const transition = await page.locator(target).evaluate(e=>getComputedStyle(e).transition);
      for (const [theme,border] of [['dark','aurora'],['dark','mono'],['glass','off'],['glass','aurora'],['glass','mono'],['dark','off']]) {
        await page.evaluate(([theme,border])=>{
          window.fixture={theme,border_effect:border}; window.themeChanged({payload:window.fixture});
        },[theme,border]);
        await page.waitForFunction(([theme,border])=>document.documentElement.dataset.wislandTheme===theme && document.documentElement.dataset.borderEffect===border,[theme,border]);
        assert.equal(await page.locator(target).evaluate(e=>getComputedStyle(e).transition),transition,'existing transition remains unchanged');
        assert.equal(await page.evaluate(()=>document.documentElement.dataset.acrylic),String(theme==='glass'));
        if (theme==='glass' && surface==='capsule') {
          assert.ok(await page.evaluate(()=>window.commands.some(c=>c.command==='sync_capsule_theme_clip' && c.args.bounds?.length===5)));
          await page.evaluate(()=>{document.body.classList.add('minimized');document.getElementById('island-capsule').classList.add('minimized');});
          await page.waitForFunction(()=>window.commands.some(c=>c.command==='sync_capsule_theme_clip' && c.args.bounds?.[2]===60 && c.args.bounds?.[3]===4));
          await page.evaluate(()=>{document.body.classList.remove('minimized');document.getElementById('island-capsule').classList.remove('minimized');});
        }
        if (theme==='glass' && surface==='settings') {
          const sidebarFill = await page.locator('.sidebar').evaluate(e=>getComputedStyle(e).backgroundColor);
          for (const selector of ['.menu-prelayer-front','.menu-prelayer-back']) {
            assert.equal(await page.locator(selector).evaluate(e=>getComputedStyle(e).backgroundColor),sidebarFill,'glass intro and resting sidebar share the same dark gray');
          }
          await page.waitForTimeout(900);
          assert.equal(await page.locator('.menu-prelayers').evaluate(e=>getComputedStyle(e).visibility),'hidden','completed intro layer does not tint acrylic purple');
        }
        if (['aurora','mono'].includes(border) && surface!=='capsule') {
          assert.equal(await page.locator(target).evaluate(e=>getComputedStyle(e,'::after').animationDuration),border==='aurora'?'4s':'6s');
        }
      }
      await page.evaluate(()=>{window.nativeAcrylic=false;window.fixture={theme:'glass',border_effect:'off'};window.themeChanged({payload:window.fixture});});
      await page.waitForFunction(()=>document.documentElement.dataset.wislandTheme==='glass' && document.documentElement.dataset.acrylic==='false');
      const fallback = await page.locator(target).evaluate(e=>getComputedStyle(e).backgroundColor);
      assert.ok(!['transparent','rgba(0, 0, 0, 0)'].includes(fallback),`${surface} has opaque fallback`);
      assert.deepEqual(errors,[]);
      await page.close();
    }
    console.log('PASS: independent themes and borders across 3 surfaces / native fallback / border speeds / capsule and indicator clip / gray glass intro / unchanged transitions');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
