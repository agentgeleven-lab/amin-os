import test from 'node:test';
import assert from 'node:assert/strict';
import {clampPosition,drawerPlacement} from '../window-state.js';
test('launcher and drawer stay visible after moving from a large screen to mobile',()=>{
  for(const [w,h]of [[1440,900],[390,844],[320,568],[844,390]]){
    const p=clampPosition({x:1400,y:880},w,h),r=drawerPlacement(p,w,h);
    assert.ok(p.x>=8&&p.x+126<=w-8);assert.ok(p.y>=8&&p.y+52<=h-8);
    assert.ok(r.x>=8&&r.x+r.width<=w-8);assert.ok(r.y>=8&&r.y+r.height<=h-8);
  }
});
test('invalid persisted coordinates do not result in invisible controls',()=>{
  assert.deepEqual(clampPosition({x:NaN,y:'bad'},390,844),{x:8,y:8});
});
test('moving the launcher near the top or bottom never covers application controls',()=>{
  for(const y of [8,150,400,650,784]){
    const p=clampPosition({x:250,y},390,844),r=drawerPlacement(p,390,844);
    assert.ok(r.y+r.height<=p.y-12||r.y>=p.y+64);
    assert.ok(r.height>0&&r.y>=8&&r.y+r.height<=836);
  }
});
