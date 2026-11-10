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
    await page.locator('#update-manual').click();
    assert.ok(await page.evaluate(()=>window.commands.some(c=>c.command==='open_update_release')));
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
    assert.ok((await page.locator('#update-message').textContent()).includes('签名校验失败'));
    await page.waitForTimeout(800);
    await page.locator('.content-body').evaluate(e=>e.scrollTop=0);
    assert.equal(await page.locator('.content').evaluate(e=>getComputedStyle(e).opacity),'1');
    await page.screenshot({path:'target/updater-settings-qa.png'});
    console.log('PASS: update preferences / safe notes / explicit confirm and cancel / version binding / progress / failures');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
