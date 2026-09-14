import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');let count=0;
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(/\.(?:m?js|json)$/.test(file)){const source=fs.readFileSync(file,'utf8');if(file.endsWith('.json'))JSON.parse(source);else{const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status)throw Error(result.stderr);for(const match of source.matchAll(/^import\s+(?:[^;\n]*?\s+from\s+)?['"](\.[^'"]+)['"]/gm)){if(!fs.existsSync(path.resolve(path.dirname(file),match[1])))throw Error('Missing import '+file+' '+match[1]);}count++;}}}}
walk(root);const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));for(const key of ['js','css'])if(!fs.existsSync(path.join(root,manifest[key])))throw Error('Missing entry '+key);
const html=fs.readFileSync(path.join(root,'apps/status/hud.html'),'utf8');for(const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)){const r=spawnSync(process.execPath,['--check'],{input:match[1],encoding:'utf8'});if(r.status)throw Error(r.stderr);}
console.log(`PASS: ${count} JS modules, relative imports, JSON, entry points and HUD inline script`);
