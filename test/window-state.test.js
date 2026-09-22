import test from 'node:test';
import assert from 'node:assert/strict';
import {clampPosition,drawerPlacement,resizedHeight} from '../window-state.js';
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
test('desktop drawer follows launcher while phone sheet remains usable independently of it',()=>{
  for(const y of [8,150,400,650,784]){
    const p=clampPosition({x:800,y},1200,844),r=drawerPlacement(p,1200,844);
    assert.ok(r.y+r.height<=p.y-12||r.y>=p.y+64);
    assert.ok(r.height>0&&r.y>=8&&r.y+r.height<=836);
    assert.deepEqual(drawerPlacement(p,390,844),{x:8,y:8,width:374,height:828});
  }
});

test('phone keyboard-sized viewport retains usable full-width content regardless saved height',()=>{
 assert.deepEqual(drawerPlacement({x:220,y:350},390,360,{width:800,height:1000}),{x:8,y:8,width:374,height:344});
 assert.deepEqual(drawerPlacement({x:0,y:0},320,220,{height:720}),{x:8,y:8,width:304,height:204});
});

test('vertical resizing follows the free edge and stays within usable screen height',()=>{
 assert.equal(resizedHeight(500,100,'top',700),400);assert.equal(resizedHeight(500,100,'bottom',700),600);
 assert.equal(resizedHeight(500,-1000,'top',700),700);assert.equal(resizedHeight(500,1000,'top',700),220);
 assert.equal(resizedHeight(500,0,'bottom',150),150);assert.equal(resizedHeight(NaN,NaN,'top',700),220);
});
