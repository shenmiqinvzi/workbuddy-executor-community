#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {desktopArguments} from './open-workbench.mjs';

const gateway=path.resolve(import.meta.dirname,'..');
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(value,k)))throw Error('Invalid workbench routing configuration.');}
export function selectWorkbenchRoute(config,args){
    exact(config,['version','defaultRoute','unknownTaskRoute','routes']);
    if(config.version!==1||!Array.isArray(config.routes)||!config.routes.length||config.routes.length>4)throw Error('Unsupported workbench routes.');
    // Reuse the native launcher's identity and option validation before any DB read.
    desktopArguments(args,gateway,process.execPath,{});
    const ids=new Set(),databases=new Set();
    for(const route of config.routes){
        exact(route,['id','database','runs','dispatchEnabled']);
        if(typeof route.id!=='string'||!route.id||ids.has(route.id)||typeof route.dispatchEnabled!=='boolean'||typeof route.database!=='string'||typeof route.runs!=='string'||!path.isAbsolute(route.database)||!path.isAbsolute(route.runs))throw Error('Invalid or duplicate workbench route.');
        const canonical=fs.realpathSync.native(route.database),key=process.platform==='win32'?canonical.toLowerCase():canonical;
        if(!fs.statSync(canonical).isFile()||databases.has(key))throw Error('Duplicate or missing task database.');
        ids.add(route.id);databases.add(key);
    }
    if(!ids.has(config.defaultRoute)||!ids.has(config.unknownTaskRoute))throw Error('Missing default task route.');
    const taskId=args.includes('--task-id')?args[args.indexOf('--task-id')+1]:null;
    const matches=[];
    if(taskId!==null)for(const route of config.routes){
        const db=new DatabaseSync(route.database,{readOnly:true});
        try{if(db.prepare('SELECT 1 FROM tasks WHERE task_id=?').get(taskId))matches.push(route);}finally{db.close();}
    }
    if(matches.length>1)throw Error('Ambiguous task identity; no window was opened.');
    return matches[0]??config.routes.find(r=>r.id===(taskId===null?config.defaultRoute:config.unknownTaskRoute));
}
export async function openRoutedWorkbench(args=process.argv.slice(2)){
    if(args[0]!=='--routes-file'||!args[1]||!path.isAbsolute(args[1]))throw Error('Use --routes-file ABSOLUTE_FILE [--task-id ID] [--status].');
    const forwarded=args.slice(2),config=JSON.parse(fs.readFileSync(args[1],'utf8').replace(/^\uFEFF/,'')),route=selectWorkbenchRoute(config,forwarded);
    const result=await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[path.join(gateway,'scripts/open-workbench.mjs'),...forwarded],{cwd:gateway,shell:false,windowsHide:true,env:{...process.env,WORKBUDDY_DB_FILE:route.database,WORKBUDDY_RUNS_DIR:route.runs,WORKBUDDY_DESKTOP_DISPATCH_ENABLED:route.dispatchEnabled?'1':'0'},stdio:['ignore','pipe','pipe']});
        let output='';const timeout=setTimeout(()=>{child.kill();reject(Error('Routed window launch timed out.'));},15000);
        child.stdout.on('data',b=>{output+=b;if(output.length>16384){child.kill();reject(Error('Oversized launcher response.'));}});child.stderr.resume();
        child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('close',code=>{clearTimeout(timeout);try{if(code!==0)throw Error('Routed launcher failed.');resolve(JSON.parse(output));}catch(error){reject(error);}});
    });
    return {...result,dataRoute:route.id};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    try{console.log(JSON.stringify(await openRoutedWorkbench()));}catch(error){console.error(JSON.stringify({opened:false,code:'WORKBENCH_ROUTE_FAILED',message:error.message}));process.exitCode=1;}
}
