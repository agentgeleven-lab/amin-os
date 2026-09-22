import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppearance,defaults,themeVariables,validate,resolveFloor} from '../settings/appearance.js';
import {drawerPlacement,clampPosition} from '../window-state.js';
test('appearance follows global defaults while explicit app overrides persist across reloads',()=>{
 const ctx={extensionSettings:{other:{keep:true}},saveSettingsDebounced(){}};const service=createAppearance(()=>ctx);
 let state=service.snapshot();state.global.theme='paper';state.apps.status={...state.global,theme:'violet'};service.save(state);
 state=service.snapshot();state.global.theme='rose';service.save(state);
 assert.equal(service.resolve('map').theme,'rose');assert.equal(service.resolve('status').theme,'violet');
 const loaded=createAppearance(()=>ctx);assert.deepEqual(loaded.snapshot(),service.snapshot());assert.deepEqual(ctx.extensionSettings.other,{keep:true});
 state=loaded.snapshot();delete state.apps.status;loaded.save(state);assert.equal(loaded.resolve('status').theme,'rose');
});
test('invalid settings fail atomically; snapshots cannot mutate live appearance',()=>{
 const ctx={extensionSettings:{},saveSettingsDebounced(){}};const service=createAppearance(()=>ctx),before=service.snapshot();
 const state=service.snapshot();state.global.fontSize=100;assert.throws(()=>service.save(state));assert.deepEqual(service.snapshot(),before);assert.deepEqual(ctx.extensionSettings,{});
 assert.throws(()=>validate({...defaults(),window:{width:NaN,height:720}}));
 const broken=createAppearance(()=>({extensionSettings:{amin_os_appearance_v1:{global:{theme:'missing'}}}}));assert.deepEqual(broken.snapshot(),defaults());
});
test('configured wide desktop window stays inside desktop and mobile viewports',()=>{
 for(const [w,h]of [[1440,900],[390,844],[320,568]]){const p=clampPosition({x:1300,y:810},w,h),r=drawerPlacement(p,w,h,{width:800,height:1000});assert.ok(r.x>=0&&r.y>=0);assert.ok(r.x+r.width<=w);assert.ok(r.y+r.height<=h);}
});
test('unified palette drives map and status alongside shell font and surface settings',()=>{
 const vars=themeVariables({...defaults().global,theme:'paper',fontSize:17,radius:6,density:'compact'});
 assert.equal(vars['--amin-bg'],vars['--wsh-bg']);assert.equal(vars['--amin-bg'],vars['--dm-bg']);assert.equal(vars['--wsh-scheme'],'light');assert.equal(vars['--amin-font'],'17px');assert.equal(vars['--amin-gap'],'8px');assert.equal(vars['--wsh-radius'],'6px');
});
test('floor dimensions migrate, share defaults, and allow independent overrides',()=>{
 const state=validate({floor:{width:800,desktopHeight:60,mobileHeight:50}});
 assert.equal(state.floor.alignment,'left');assert.equal(state.floor.sizeMode,'fixed');
 assert.equal(resolveFloor(state,'map').width,800);assert.equal(resolveFloor(state,'status').width,800);
 state.floor.overrides.map={width:500,desktopHeight:45,mobileHeight:40};state.floor.alignment='right';
 const saved=validate(state);assert.equal(resolveFloor(saved,'map').width,500);assert.equal(resolveFloor(saved,'status').width,800);
 delete saved.floor.overrides.map;assert.equal(resolveFloor(saved,'map').width,800);
 assert.throws(()=>validate({...saved,floor:{...saved.floor,alignment:'bad'}}));
});

test('floor button visibility migrates and reply sizes persist independently',()=>{
 const old=validate({floor:{width:800}});assert.deepEqual(old.floor.buttons,{map:true,status:true,dice:true,scene:true,journal:true,organizations:true,reply:true,effects:true,information:true,worldbooks:true,tts:true});
 old.floor.buttons.status=false;old.floor.overrides.reply={width:500,desktopHeight:40,mobileHeight:45};
 const ctx={extensionSettings:{},saveSettingsDebounced(){}};createAppearance(()=>ctx).save(old);
 const restored=createAppearance(()=>ctx).snapshot();assert.equal(restored.floor.buttons.status,false);
 assert.equal(restored.floor.buttons.reply,true);assert.equal(resolveFloor(restored,'reply').width,500);
 assert.equal(resolveFloor(restored,'map').width,800);
});

test('desktop style migrates independently and persists without changing app themes',()=>{
 const legacy=defaults();delete legacy.desktop;assert.equal(validate(legacy).desktop.style,'classic');
 const ctx={extensionSettings:{},saveSettingsDebounced(){}};const service=createAppearance(()=>ctx);const next=service.snapshot();next.desktop.style='win10';service.save(next);
 const reloaded=createAppearance(()=>ctx);assert.equal(reloaded.snapshot().desktop.style,'win10');assert.deepEqual(reloaded.snapshot().global,defaults().global);assert.throws(()=>validate({...next,desktop:{style:'invalid'}}));
});

test('Windows 10 window pairing follows desktop choice and preserves independent app themes',()=>{
 const ctx={extensionSettings:{},saveSettingsDebounced(){}};const a=createAppearance(()=>ctx);const d=a.snapshot();d.desktop.style='win10';a.save(d);
 assert.equal(a.resolve('').theme,'win10');assert.equal(a.resolve('information').radius,0);
 d.apps.map={...d.global,theme:'paper'};a.save(d);assert.equal(a.resolve('map').theme,'paper');assert.equal(a.resolve('information').theme,'win10');
 d.desktop.windowTheme='current';a.save(d);assert.equal(a.resolve('information').theme,d.global.theme);
});

test('explicit Windows light overrides automatic dark and accent text remains readable',()=>{
 const ctx={extensionSettings:{},saveSettingsDebounced(){}};const a=createAppearance(()=>ctx),d=a.snapshot();d.desktop.style='win10';d.desktop.windowTheme='win10light';a.save(d);assert.equal(a.resolve('').theme,'win10light');assert.equal(themeVariables(a.resolve(''))['--amin-accent-text'],'#202020');
 d.desktop.windowTheme='win10';a.save(d);assert.equal(themeVariables(a.resolve(''))['--amin-accent-text'],'#ffffff');assert.equal(themeVariables(a.resolve(''))['--amin-accent'],'#0078d4');
});
test('worldbook floor visibility and separate dimensions persist without changing other apps',()=>{
 const ctx={extensionSettings:{},saveSettingsDebounced(){}},a=createAppearance(()=>ctx),s=a.snapshot();
 assert.equal(s.floor.buttons.worldbooks,true);s.floor.buttons.worldbooks=false;s.floor.overrides.worldbooks={width:620,desktopHeight:50,mobileHeight:45};a.save(s);
 const restored=createAppearance(()=>ctx).snapshot();assert.equal(restored.floor.buttons.worldbooks,false);assert.equal(resolveFloor(restored,'worldbooks').width,620);assert.equal(resolveFloor(restored,'map').width,900);
});
