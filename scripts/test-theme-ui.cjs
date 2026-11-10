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
          for (const selector of ['.menu-prelayer-front','.menu-prelayer-back']) {
            assert.equal(await page.locator(selector).evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)','underlays must not tint the native glass a second time');
            assert.equal(await page.locator(selector).evaluate(e=>getComputedStyle(e).backdropFilter),'none','underlays must not blur the backdrop a second time');
          }
          if (border==='off') {
            await page.evaluate(async()=>{
              // Synthetic native-backdrop color: browser captures cannot include DWM.
              document.documentElement.style.backgroundColor='#8899aa';
              const shell=document.getElementById('settings-shell');
              shell.classList.remove('menu-open'); void shell.offsetWidth;
              await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
              shell.classList.add('menu-open'); void shell.offsetWidth;
              window.introAnimations=document.getAnimations();
              window.introAnimations.forEach(a=>a.pause());
            });
            const samples=[];
            for (const ms of [500,750,950,1300]) {
              await page.evaluate(ms=>window.introAnimations.forEach(a=>a.currentTime=ms),ms);
              const png=(await page.screenshot()).toString('base64');
              samples.push(await page.evaluate(async png=>{
                const img=new Image(); img.src='data:image/png;base64,'+png; await img.decode();
                const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
                const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
                return Array.from(ctx.getImageData(50,550,1,1).data);
              },png));
            }
            assert.ok(samples.every(s=>s.every((n,i)=>Math.abs(n-samples[0][i])<=1)),`intro tint must not jump when underlays finish: ${JSON.stringify(samples)}`);
            assert.ok(samples[0][0]<130 && samples[0][3]===255,'sample is inside the tinted sidebar, not the uncovered backdrop');
            await page.evaluate(()=>{window.introAnimations.forEach(a=>a.finish());document.documentElement.style.removeProperty('background-color');});
          }
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
