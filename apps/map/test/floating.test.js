import test from 'node:test';
import assert from 'node:assert/strict';
import {fitWindowPosition} from '../src/ui/floating.js';

test('map window remains reachable after mobile keyboard reduces the visible viewport',()=>{
    const placed=fitWindowPosition({x:900,y:650},{width:344,height:270},{width:360,height:310});
    assert.deepEqual(placed,{x:8,y:32});
    assert.ok(placed.y+270<=310-8);
});

test('map window follows visual viewport offsets after phone zoom or pan',()=>{
    const placed=fitWindowPosition({x:0,y:0},{width:280,height:200},{width:320,height:400,offsetLeft:40,offsetTop:120});
    assert.deepEqual(placed,{x:48,y:128});
});

test('oversize map windows retain a visible drag handle',()=>{
    const placed=fitWindowPosition({x:700,y:600},{width:600,height:700},{width:320,height:240});
    assert.deepEqual(placed,{x:8,y:8});
});
