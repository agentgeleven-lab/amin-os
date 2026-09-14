import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppearance,defaults,themeVariables,validate} from '../settings/appearance.js';
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
