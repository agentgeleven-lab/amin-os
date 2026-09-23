import test from 'node:test';
import assert from 'node:assert/strict';
import {TILE_PALETTE,applyTileColors,createTileColorEditor} from '../tile-colors.js';
import {defaultTiles} from '../tile-layout.js';

const make=(tag,className='',text='')=>({tag,className,text,children:[],dataset:{},attributes:{},style:{values:{},setProperty(key,value){this.values[key]=value;},removeProperty(key){delete this.values[key];}},append(...children){this.children.push(...children);},setAttribute(key,value){this.attributes[key]=value;}});
test('every default app has a distinct dark tile background',()=>{
 const colors=defaultTiles().map(tile=>TILE_PALETTE[tile.target]);
 assert.equal(new Set(colors).size,colors.length);
 for(const color of colors){assert.match(color,/^#[0-9a-f]{6}$/i);const rgb=color.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);const lum=rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;assert.ok(1.05/(lum+.05)>=4.5,`${color} must support white text`);}
});
test('custom colors are independent and removed when reset or invalid',()=>{
 const button=make('button');applyTileColors(button,{target:'dice',backgroundColor:'#112233',iconColor:'#ABCDEF'});
 assert.equal(button.style.values['--amin-tile-custom-bg'],'#112233');assert.equal(button.style.values['--amin-tile-custom-icon'],'#ABCDEF');assert.equal(button.style.values['--amin-tile-custom-text'],undefined);
 applyTileColors(button,{target:'status',textColor:'#001122',backgroundColor:'url(secret)'});
 assert.equal(button.style.values['--amin-tile-custom-bg'],undefined);assert.equal(button.style.values['--amin-tile-custom-icon'],undefined);assert.equal(button.style.values['--amin-tile-custom-text'],'#001122');assert.equal(button.dataset.customBackground,'false');
});
test('editor changes only enabled field, resets all, and disables missing selection',()=>{
 const patches=[],field=(label,control)=>{const el=make('label','',label);el.append(control);return el;};
 const editor=createTileColorEditor({make,field,onChange:patch=>patches.push(patch)});
 const [bgRow,textRow,iconRow,reset]=editor.element.children;
 const bgEnabled=bgRow.children[0].children[0],bgPicker=bgRow.children[1];
 assert.equal(bgEnabled.disabled,true);editor.sync({target:'dice',textColor:'#123456'});
 assert.equal(bgPicker.disabled,true);assert.equal(textRow.children[1].disabled,false);assert.equal(iconRow.children[1].value,'#123456');
 bgEnabled.checked=true;bgEnabled.onchange();assert.deepEqual(patches.pop(),{backgroundColor:TILE_PALETTE.dice});
 editor.sync({target:'dice',backgroundColor:TILE_PALETTE.dice});bgPicker.value='#000000';bgPicker.oninput();assert.deepEqual(patches.pop(),{backgroundColor:'#000000'});
 bgEnabled.checked=false;bgEnabled.onchange();assert.deepEqual(patches.pop(),{backgroundColor:''});
 reset.onclick();assert.deepEqual(patches.pop(),{backgroundColor:'',textColor:'',iconColor:''});
 editor.sync(null);assert.equal(reset.disabled,true);assert.equal(bgPicker.disabled,true);
});
