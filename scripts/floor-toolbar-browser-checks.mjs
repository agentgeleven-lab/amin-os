import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function checkFloorToolbar({send,evaluate,waitFor,delay,artifacts,checks}) {
    await evaluate("AminOS.close();window.floorAppearance=(await import('/settings/appearance.js')).getAppearance();window.floorBefore=floorAppearance.snapshot();window.floorRow=()=>document.querySelector('[mesid=\"1\"] .amin-floor-toolbar');window.floorOrder=()=>[...floorRow().querySelectorAll(':scope > button[data-floor-app]')].map(b=>b.dataset.floorApp)");
    await waitFor("!!floorRow()?.querySelector('[data-floor-app=status]')&&!!floorRow()?.querySelector('[data-floor-app=dice]')",'status and dice toolbar registration');
    const point=async(id,left=false)=>evaluate(`(()=>{const r=floorRow().querySelector('[data-floor-app="${id}"]').getBoundingClientRect();return {x:r.left+r.width*${left ? 0.2 : 0.5},y:r.top+r.height/2};})()`);
    const mouse=async(type,p)=>send('Input.dispatchMouseEvent',{type,...p,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1});
    const touch=async(type,p)=>send('Input.dispatchTouchEvent',{type,touchPoints:p?[{...p,id:1,radiusX:2,radiusY:2}]:[]});
    try {
        await evaluate("const next=floorAppearance.snapshot();next.floor.moreButtons=['status'];next.floor.toolbarAlignment='right';floorAppearance.save(next);window.originalFloorStatus=floorRow().querySelector('[data-floor-app=status]')");
        assert.equal(await evaluate("originalFloorStatus.hidden"),false,'More is not disabled/hidden app preference');
        assert.equal(await evaluate("visible(originalFloorStatus)"),false);
        assert.equal(await evaluate("getComputedStyle(floorRow()).justifyContent"),'flex-end');
        await evaluate("floorRow().querySelector('.amin-floor-toolbar-more').click();originalFloorStatus.click()");
        await waitFor("!!document.querySelector('[mesid=\"1\"] .wsh-workbench iframe')?.contentDocument?.getElementById('mode')",'More opens original world status');
        await evaluate("window.floorFrame=document.querySelector('[mesid=\"1\"] .wsh-workbench iframe');window.floorFrameDocument=floorFrame.contentDocument;floorRow().querySelector('.amin-floor-toolbar-edit').click();floorRow().scrollIntoView({block:'start'})");
        const from=await point('dice'),to=await point('characters',true);
        await mouse('mousePressed',from);await mouse('mouseMoved',to);await mouse('mouseReleased',to);
        assert.equal(await evaluate("floorOrder().indexOf('dice')<floorOrder().indexOf('characters')"),true,'real mouse drag saves before target');
        assert.equal(await evaluate("[...document.querySelectorAll('.amin-floor-toolbar')].every(row=>[...row.querySelectorAll('button[data-floor-app]')].filter(b=>b.parentElement===row).map(b=>b.dataset.floorApp).indexOf('dice')<[...row.querySelectorAll('button[data-floor-app]')].filter(b=>b.parentElement===row).map(b=>b.dataset.floorApp).indexOf('characters'))"),true,'all floors receive saved order');
        assert.equal(await evaluate("floorFrame.contentDocument===floorFrameDocument"),true,'sorting retains live iframe');
        assert.equal(await evaluate("floorRow().querySelector('[data-floor-app=status]')===originalFloorStatus"),true,'original button retains identity');
        await evaluate("floorRow().querySelector('.amin-floor-toolbar-edit').click();document.querySelector('[mesid=\"1\"] .wsh-workbench .wsh-panel-heading button').click()");
        await send('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:1,mobile:true});
        await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
        await evaluate("const next=floorAppearance.snapshot();next.floor.moreButtons=[];next.floor.buttonOrder=['dice','characters',...next.floor.buttonOrder.filter(id=>!['dice','characters'].includes(id))];floorAppearance.save(next);floorRow().scrollIntoView({block:'start'})");
        const hold=await point('dice');await touch('touchStart',hold);await delay(650);await touch('touchEnd');
        assert.equal(await evaluate("floorRow().dataset.editing"),'true','touch long press enters edit mode');
        assert.equal(await evaluate("document.querySelectorAll('[mesid=\"1\"] .amin-extra-floor-window').length"),0,'long press never opens app');
        await evaluate("floorRow().scrollIntoView({block:'start'})");
        const touchFrom=await point('characters'),touchTo=await point('dice',true);
        await touch('touchStart',touchFrom);await touch('touchMove',touchTo);await touch('touchEnd');
        assert.equal(await evaluate("floorAppearance.snapshot().floor.buttonOrder[0]"),'characters','real touch drag reorders');
        const saved=await evaluate("JSON.stringify(floorAppearance.snapshot().floor.buttonOrder)");
        await touch('touchStart',await point('characters'));await touch('touchMove',await point('dice'));await touch('touchCancel');
        assert.equal(await evaluate("JSON.stringify(floorAppearance.snapshot().floor.buttonOrder)"),saved,'touch cancellation does not save');
        await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        assert.equal(await evaluate("floorRow().dataset.editing"),'false');
        assert.deepEqual(await evaluate("(await import('/settings/appearance.js')).createAppearance(()=>ctx).snapshot().floor.buttonOrder"),JSON.parse(saved),'saved settings reload');
        assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"),true,'320px toolbar has no page overflow');
        assert.equal(await evaluate("[...floorRow().querySelectorAll('button')].filter(visible).every(b=>b.getBoundingClientRect().height>=44)"),true,'mobile buttons >=44px');
        const image=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifacts,'floor-toolbar-320.png'),Buffer.from(image.data,'base64'));
        await evaluate("AminOS.openApp('settings')");
        await evaluate("clickButton('settings','楼层窗口')");
        await evaluate("pane('settings').querySelector('[data-floor-button=status] input').click();clickButton('settings','世界状态上移')");
        await evaluate("fillField('settings','按钮整排对齐','center');clickButton('settings','保存并应用')");
        assert.ok(await evaluate("floorAppearance.snapshot().floor.moreButtons.includes('status')"),'settings adds More member');
        assert.equal(await evaluate("floorAppearance.snapshot().floor.toolbarAlignment"),'center');
        assert.equal(await evaluate("floorAppearance.snapshot().floor.alignment"),'left','window alignment unchanged');
        await evaluate("pane('settings').querySelector('.amin-floor-order-settings').scrollIntoView({block:'start'})");
        assert.equal(await evaluate("pane('settings').scrollWidth<=pane('settings').clientWidth+1"),true,'settings order editor fits phone');
        const settingsImage=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifacts,'floor-toolbar-settings-320.png'),Buffer.from(settingsImage.data,'base64'));
        await evaluate("clickButton('settings','恢复按钮默认排列');clickButton('settings','保存并应用')");
        assert.deepEqual(await evaluate("floorAppearance.snapshot().floor.moreButtons"),[],'restore toolbar defaults');
        await evaluate("AminOS.close();floorRow().querySelector('[data-floor-app=dice]').focus();window.focusedFloorButton=document.activeElement;ctx.eventSource.emit('MESSAGE_UPDATED',1)");
        await delay(850);
        assert.equal(await evaluate("document.activeElement===focusedFloorButton"),true,'background floor refresh retains button focus');
        checks.push('Floor toolbar: real mouse and touch drag, long press without app launch, cancel, global persisted order, independent alignment, original More buttons and live status iframe retained, 320px controls');
    } finally {
        await send('Emulation.setTouchEmulationEnabled',{enabled:false});
        await send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
        await evaluate("floorAppearance.save(floorBefore);window.scrollTo(0,0)");
    }
}
