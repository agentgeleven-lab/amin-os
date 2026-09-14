import test from 'node:test';
import assert from 'node:assert/strict';
import {mountFloorControl} from '../settings/floor-layout.js';
class Node{
 constructor(){this.children=[];this.dataset={};this.hidden=false;this.style={};}
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

test('three windows keep opening order and reopening moves a window to the end',()=>{
 const document={createElement:()=>new Node()},message=new Node();
 const hosts=[new Node(),new Node(),new Node()],buttons=[new Node(),new Node(),new Node()];
 const docks=['map','status','reply'].map((id,i)=>mountFloorControl(message,id,hosts[i],buttons[i],document));
 docks[2].setOpen(true);docks[0].setOpen(true);docks[1].setOpen(true);
 assert.deepEqual(hosts.map(h=>h.style.order),['2','3','1']);
 docks[2].setOpen(false);docks[2].setOpen(true);
 assert.deepEqual(hosts.map(h=>h.style.order),['1','2','3']);
 docks[0].dispose();assert.deepEqual(hosts.slice(1).map(h=>h.style.order),['1','2']);
 docks[1].dispose();docks[2].dispose();assert.equal(message.children.length,0);
});
