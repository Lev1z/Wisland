const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { chromium } = require('../target/tray-qa-tools/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 920, height: 740 } });
    await page.setContent(fs.readFileSync('settings.html','utf8').replace(/<script[\s\S]*?<\/script>/g,''));
    await page.addStyleTag({ content: fs.readFileSync('src/settings.css','utf8') });
    await page.addStyleTag({ content: fs.readFileSync('src/theme.css','utf8') });
    await page.evaluate(() => {
      document.getElementById('settings-shell').classList.add('menu-open');
      document.getElementById('page-title').textContent = '关于';
      document.querySelectorAll('.page').forEach(p=>p.classList.remove('active')); document.getElementById('page-about').classList.add('active');
      window.commands = []; window.updateFixtureStatus = { autoCheck:true,phase:'idle',version:null,notes:'',error:null,downloaded:0,total:null,checkedAt:0 };
      window.module = {exports:{}}; window.exports=window.module.exports;
      window.require = () => ({ listen: async (_name,cb)=> { window.statusEvent=cb;return ()=>{}; }, invoke:async(command,args)=>{window.commands.push({command,args});if(command==='set_auto_update_check')window.updateFixtureStatus.autoCheck=args.enabled;return {...window.updateFixtureStatus};} });
    });
    await page.addScriptTag({ content:ts.transpileModule(fs.readFileSync('src/settings-updater.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText });
    await page.evaluate(()=>window.module.exports.initUpdater());
    assert.equal(await page.locator('#update-install').isVisible(),false);
    assert.equal(await page.locator('#update-message').isVisible(),false);
    assert.equal(await page.locator('.update-card #update-manual').count(),0);
    await page.locator('#update-auto').uncheck();
    await page.evaluate(()=> { window.updateFixtureStatus={...window.updateFixtureStatus,phase:'available',version:'0.2.3',notes:'<script>bad()</script>\nRelease notes'}; window.statusEvent({payload:window.updateFixtureStatus}); });
    assert.equal(await page.locator('#update-notes script').count(),0);
    await page.locator('#update-install').click(); assert.equal(await page.locator('#update-confirm').isVisible(),true);
    assert.equal(await page.evaluate(()=>window.commands.filter(c=>c.command==='install_update').length),0);
    await page.locator('#update-cancel').click(); assert.equal(await page.locator('#update-confirm').isVisible(),false);
    await page.locator('#update-install').click(); await page.locator('#update-confirm-install').click();
    assert.deepEqual(await page.evaluate(()=>window.commands.filter(c=>c.command==='install_update')), [{command:'install_update',args:{confirmedVersion:'0.2.3'}}]);
    await page.evaluate(()=>window.statusEvent({payload:{...window.updateFixtureStatus,phase:'downloading',downloaded:25,total:100}}));
    assert.equal(await page.locator('#update-progress').getAttribute('value'),'25');
    assert.equal(await page.locator('#update-check').isDisabled(),true);
    await page.evaluate(()=>window.statusEvent({payload:{...window.updateFixtureStatus,phase:'error',error:'签名校验失败，未执行安装'}}));
    assert.equal(await page.locator('#update-details').isVisible(),true,'failures open automatically');
    assert.ok((await page.locator('#update-detail-status').textContent()).includes('签名校验失败'));
    assert.equal(await page.locator('#update-notes script').count(),0);
    await page.locator('#update-manual').click();
    assert.ok(await page.evaluate(()=>window.commands.some(c=>c.command==='open_update_release')));
    assert.ok(await page.locator('#update-manual').evaluate(e=>e.getBoundingClientRect().right<=document.getElementById('update-details-close').getBoundingClientRect().left));
    await page.locator('#update-details-close').click();
    for (const size of [{width:760,height:500},{width:960,height:620},{width:1440,height:900}]) {
      await page.setViewportSize(size);
      for (const phase of ['idle','checking','current','available','downloading','verifying','installing','error']) {
        await page.evaluate(phase=>window.statusEvent({payload:{...window.updateFixtureStatus,phase,error:phase==='error'?'长错误'.repeat(300):null,checkedAt:1794300000}}),phase);
        if (phase === 'idle') assert.equal(await page.locator('#update-message').isVisible(),false);
        assert.ok(await page.locator('.update-actions').evaluate(e=>Math.abs(e.getBoundingClientRect().right-document.getElementById('update-checked').getBoundingClientRect().right)<1),'check action and timestamp align on right');
        assert.ok(await page.locator('.update-card').evaluate(e=>e.getBoundingClientRect().height<=80 && e.scrollWidth<=e.clientWidth),'two compact rows across sizes and states');
        assert.ok(await page.locator('.update-card').evaluate(e=>e.getBoundingClientRect().top>=document.querySelector('.about-brand').getBoundingClientRect().bottom),'updater follows brand information');
      }
      await page.locator('#update-details-close').click();
    }
    await page.setViewportSize({width:960,height:620});
    await page.evaluate(()=>document.documentElement.dataset.wislandTheme='glass');
    await page.evaluate(()=>window.statusEvent({payload:{...window.updateFixtureStatus,phase:'error',error:'网络不可用',checkedAt:42}}));
    assert.equal(await page.locator('#update-details').isVisible(),true);
    assert.equal(await page.locator('#update-details').evaluate(e=>getComputedStyle(e).backdropFilter),'blur(22px)');
    await page.locator('#update-details-close').click();
    await page.evaluate(()=>window.statusEvent({payload:{...window.updateFixtureStatus,phase:'error',error:'网络不可用',checkedAt:42}}));
    assert.equal(await page.locator('#update-details').isVisible(),false,'identical failure does not reopen a dismissed dialog');
    await page.evaluate(()=>{
      document.getElementById('page-about').classList.remove('active');
      document.getElementById('page-general').classList.add('active');
      window.statusEvent({payload:{...window.updateFixtureStatus,phase:'error',error:'另一检查失败',checkedAt:43}});
    });
    assert.equal(await page.locator('#update-details').isVisible(),true,'failure dialog works outside About page');
    await page.locator('#update-details-close').click();
    await page.evaluate(()=>{document.getElementById('page-general').classList.remove('active');document.getElementById('page-about').classList.add('active');});
    await page.evaluate(()=>window.statusEvent({payload:{...window.updateFixtureStatus,phase:'current',error:null,notes:'',checkedAt:Math.floor(Date.now()/1000)}}));
    await page.waitForTimeout(800);
    await page.locator('.content-body').evaluate(e=>e.scrollTop=0);
    assert.equal(await page.locator('.content').evaluate(e=>getComputedStyle(e).opacity),'1');
    await page.screenshot({path:'target/updater-settings-qa.png'});
    console.log('PASS: update preferences / safe notes / explicit confirm and cancel / version binding / progress / failures');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
