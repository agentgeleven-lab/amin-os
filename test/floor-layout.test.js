import test from 'node:test';
import assert from 'node:assert/strict';
import {mountFloorControl} from '../settings/floor-layout.js';
class Node{
 constructor(){this.children=[];this.dataset={};this.hidden=false;}
 append(...nodes){for(const n of nodes){n.remove();n.parent=this;this.children.push(n);}}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=null;}
 setAttribute(){}querySelector(){return null;}
}
test('floor controls share one row and preserve independent lifecycle and visibility',()=>{
 const document={createElement:()=>new Node()},message=new Node(),text=new Node();message.append(text);
 const mapHost=new Node(),mapButton=new Node(),statusHost=new Node(),statusButton=new Node();
 const map=mountFloorControl(message,'map',mapHost,mapButton,document),status=mountFloorControl(message,'status',statusHost,statusButton,document);
 assert.equal(message.children.length,2);const root=message.children[1];assert.equal(root.children[0].children.length,2);assert.equal(mapHost.parent,statusHost.parent);
 map.setVisible(false);assert.equal(mapButton.hidden,true);assert.equal(statusButton.hidden,false);assert.equal(root.hidden,false);
 status.setVisible(false);assert.equal(root.hidden,true);status.setVisible(true);assert.equal(root.hidden,false);
 map.dispose();assert.equal(root.children[0].children.length,1);status.dispose();assert.deepEqual(message.children,[text]);
});
