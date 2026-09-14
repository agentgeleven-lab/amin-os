import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const fixtures={
 '/scripts/variables.js':`export function setLocalVariable(k,v){const ctx=globalThis.SillyTavern.getContext();ctx.chatMetadata.variables??={};ctx.chatMetadata.variables[k]=v;}`,
 '/scripts/world-info.js':`export const selected_world_info=[];export const world_info={};export async function loadWorldInfo(){return {entries:{}};}export function getWorldInfoSettings(){return {world_info:{globalSelect:[]}};}`,
 '/scripts/utils.js':`export function uuidv4(){return crypto.randomUUID();}`,
};
const server=http.createServer((req,res)=>{let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);}catch{res.writeHead(400).end();return;}
 if(fixtures[pathname]){res.writeHead(200,{'Content-Type':'text/javascript;charset=utf-8'});res.end(fixtures[pathname]);return;}
 const file=path.resolve(root,'.'+(pathname==='/'?'/preview.html':pathname));
 if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 try{const contents=fs.readFileSync(file);res.writeHead(200,{'Content-Type':({'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json'})[path.extname(file)]+';charset=utf-8','Cache-Control':'no-store'});res.end(contents);}catch{res.writeHead(404).end();}
});
server.listen(Number(process.env.PORT??8766),'127.0.0.1',()=>console.log('Amin os preview: http://127.0.0.1:'+server.address().port));
