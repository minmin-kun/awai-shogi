import {readFile,mkdir,writeFile,cp,rm} from 'node:fs/promises';
const base=new URL('../',import.meta.url);const read=p=>readFile(new URL(p,base),'utf8');
const engine=(await read('src/engine.js')).replaceAll('export ','');
const api=(await read('src/api.js')).replace(/^import .*;\r?\n/gm,'').replaceAll('export ','');
const roomUpdates=(await read('public/room-updates.js')).replaceAll('export ','');
const realtime=(await read('src/realtime.js')).replace(/^import .*;\r?\n/gm,'');
const files={};for(const [url,path,type]of [['/','public/index.html','text/html'],['/about','public/about.html','text/html'],['/style.css','public/style.css','text/css'],['/app.js','public/app.js','text/javascript'],['/engine.js','src/engine.js','text/javascript'],['/planning.js','src/planning.js','text/javascript'],['/transport.js','public/transport.js','text/javascript'],['/room-updates.js','public/room-updates.js','text/javascript'],['/service-errors.js','public/service-errors.js','text/javascript']])files[url]={body:await read(path),type};
for(const key of ['reserve','order','double','conditional'])files[`/rules/${key}.svg`]={body:await read(`public/rules/${key}.svg`),type:'image/svg+xml'};
const serviceErrors=(await read('public/service-errors.js')).replaceAll('export ','');
const security=(await read('src/security.js')).replace(/^import .*;\r?\n/gm,'').replaceAll('export ','');
const maintenance=(await read('src/maintenance.js')).replaceAll('export ','');
const worker=(await read('src/worker.js')).replace(/^import .*;\r?\n/gm,'');
const output=`${engine}\n${serviceErrors}\n${security}\n${maintenance}\n${api}\n${roomUpdates}\n${realtime}\nconst assets=${JSON.stringify(files)};\n${worker}`;
await mkdir(new URL('dist/server/',base),{recursive:true});await mkdir(new URL('dist/.openai/',base),{recursive:true});await writeFile(new URL('dist/server/index.js',base),output);await cp(new URL('.openai/hosting.json',base),new URL('dist/.openai/hosting.json',base));await cp(new URL('drizzle/',base),new URL('dist/.openai/drizzle/',base),{recursive:true});console.log('Built dist/server/index.js');

if(process.argv.includes('--cloudflare')){await rm(new URL('dist/client/credits.html',base),{force:true});await mkdir(new URL('dist/client/',base),{recursive:true});for(const [url,asset] of Object.entries(files)){const name=url==='/'?'index.html':url==='/about'?'about.html':url.slice(1);await mkdir(new URL('dist/client/'+name.split('/').slice(0,-1).join('/')+'/',base),{recursive:true});await writeFile(new URL('dist/client/'+name,base),asset.body);}}

if(process.argv.includes('--cloudflare')){const {SECURITY_HEADERS}=await import('../src/security.js');await writeFile(new URL('dist/client/_headers',base),'/*\n'+Object.entries(SECURITY_HEADERS).map(([key,value])=>`  ${key}: ${value}`).join('\n')+'\n');}
