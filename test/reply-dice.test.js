import test from 'node:test';
import assert from 'node:assert/strict';
import {DraftSelection,generateOptions} from '../apps/reply/generator.js';
import {HISTORY_KEY} from '../apps/dice/service.js';

const fixed='【骰子 · 潜行 · #testroll】\nD20 优势取高 [8, 14] → 14 + 3 = 17；目标 15；成功';
const second='【骰子 · 幸运 · #luckroll】\nD100 普通：个位 3；十位 [20]；候选 [23] → 23；技能 50，普通目标 50；困难成功 · 达成目标';
const context=(texts=[fixed])=>({chatId:'dice-chat',chat:[{mes:'走廊尽头传来脚步声。'}],chatMetadata:{[HISTORY_KEY]:{version:1,rolls:texts.map((text,index)=>({id:'roll-'+index,text,results:[{total:17}],settings:{mode:'generic'},createdAt:10,status:'appended'}))}}});
const input=value=>({value,events:[],dispatchEvent(event){this.events.push(event.type);},focus(){},setSelectionRange(){}});

test('replacing and switching candidates keep exact known dice once and undo restores full original draft',()=>{
    const ctx=context([fixed,second]),saved=JSON.stringify(ctx.chatMetadata),original=`我贴墙走。\n\n${fixed}\n\n${second}`,element=input(original),selection=new DraftSelection(()=>ctx);
    selection.choose(element,`我屏息靠近门口。\n${fixed}\n${fixed}`,'replace');
    assert.equal(element.value,`我屏息靠近门口。\n${fixed}\n\n${second}`);
    selection.choose(element,'我等待守卫经过。','replace');
    assert.equal(element.value,`我等待守卫经过。\n${fixed}\n\n${second}`);
    selection.undo(element);
    assert.equal(element.value,original);
    assert.deepEqual(element.events,['input','input','input']);
    assert.equal(JSON.stringify(ctx.chatMetadata),saved);
});

test('appending candidates updates prose before fixed dice and does not append to the previous candidate',()=>{
    const element=input(`我贴墙走。\n${fixed}`),selection=new DraftSelection(()=>context());
    selection.choose(element,'放轻呼吸。');
    assert.equal(element.value,`我贴墙走。\n放轻呼吸。\n${fixed}`);
    selection.choose(element,'停在阴影中。');
    assert.equal(element.value,`我贴墙走。\n停在阴影中。\n${fixed}`);
});

test('editing a fixed dice block after selection blocks replacement and undo',()=>{
    const element=input(`我贴墙走。\n${fixed}`),selection=new DraftSelection(()=>context());
    selection.choose(element,'我屏息前进。','replace');
    element.value=element.value.replace('[8, 14]','[8, 19]');
    const edited=element.value;
    assert.throws(()=>selection.choose(element,'新的行动','replace'),/草稿已被你修改/);
    assert.throws(()=>selection.undo(element),/草稿已被修改/);
    assert.equal(element.value,edited);
});

test('reply and author draft generation omit known dice while retaining similarly written ordinary text',async()=>{
    const ctx=context(),requests=[];
    ctx.generateRaw=async request=>{requests.push(request);return '["候选甲","候选乙"]';};
    const ordinary='【骰子 · 手写示例】我想像他会掷出二十。';
    for(const writingMode of ['roleplay','author']){
        await generateOptions(ctx,{count:2,writingMode},{world:[],draft:`我贴墙走。\n${ordinary}\n${fixed}`});
        const request=requests.at(-1);
        assert.ok(request.prompt.includes('我贴墙走。'));
        assert.ok(request.prompt.includes(ordinary));
        assert.ok(!request.prompt.includes(fixed));
        assert.ok(!request.prompt.includes('#testroll'));
    }
});

test('records from another chat do not grant draft protection',()=>{
    const element=input(`我贴墙走。\n${fixed}`),selection=new DraftSelection(()=>({chatMetadata:{}}));
    selection.choose(element,'我离开。','replace');
    assert.equal(element.value,'我离开。');
    selection.undo(element);
    assert.equal(element.value,`我贴墙走。\n${fixed}`);
});
