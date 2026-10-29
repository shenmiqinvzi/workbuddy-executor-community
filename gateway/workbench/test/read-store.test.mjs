import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../../dist/task-store.js';
import { operationDigest } from '../../dist/operation-admission.js';
import { openWorkbenchReadStore } from '../../scripts/workbench-read-store.mjs';
import { readPanelTask } from '../../dist/workbench-panel.js';

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'workbench-read-store-')),file=path.join(dir,'tasks.sqlite');
    const writer=new TaskStore(file);
    for(const id of ['first','second']) writer.createOrGet({taskId:id,messageId:'message-'+id,objective:'Saved task '+id,state:'accepted',createdAt:'2026-10-29T00:00:00.000Z',updatedAt:'2026-10-29T00:00:00.000Z'});
    return {dir,file,writer};
}
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('pre-contract databases remain readable without migration; missing modern contract storage stays unavailable',()=>{
    for(const legacy of [true,false]) {
        const {dir,file,writer}=fixture();
        writer.db.exec('DROP TABLE task_contracts');
        if(legacy) writer.db.exec('ALTER TABLE tasks DROP COLUMN revision; ALTER TABLE tasks DROP COLUMN contract_dispatch');
        writer.close();const before=hash(file),reader=openWorkbenchReadStore(file);
        try {
            const panel=readPanelTask(reader,path.join(dir,'runs'),'first');
            if(legacy) {
                assert.deepEqual(reader.getContract('first'),{state:'absent'});
                assert.equal(panel.ok,true);assert.equal(panel.presentation.title,null);
                assert.equal(reader.get('first').revision,undefined);
            } else {
                assert.throws(()=>reader.getContract('first'));
                assert.equal(panel.ok,false);assert.equal(panel.code,'store_unavailable');
            }
            assert.equal(hash(file),before);
        } finally {reader.close();fs.rmSync(dir,{recursive:true,force:true});}
    }
});
test('read-only desktop queries preserve the existing cursor, contract, event and scope meanings',()=>{
    const {dir,file,writer}=fixture(),reader=openWorkbenchReadStore(file);
    try {
        for(const id of ['first','second','missing']) {
            assert.deepEqual(reader.get(id),writer.get(id)); assert.deepEqual(reader.getContract(id),writer.getContract(id)); assert.deepEqual(reader.listAttempts(id),writer.listAttempts(id));
            assert.deepEqual(reader.listTaskEvents(id),writer.listTaskEvents(id)); assert.deepEqual(reader.workspaceProtection.readView(id),writer.workspaceProtection.readView(id));
        }
        for(const cursor of [undefined,'first','second','missing']) {
            assert.deepEqual(reader.listTasksByCreatedCursor({limit:1,afterTaskId:cursor}),writer.listTasksByCreatedCursor({limit:1,afterTaskId:cursor}));
            if(cursor) assert.equal(reader.hasTaskAfterCursor(cursor),writer.hasTaskAfterCursor(cursor));
        }
        writer.db.prepare('UPDATE tasks SET objective=? WHERE task_id=?').run('Updated by the executor','first');
        assert.equal(reader.get('first').objective,'Updated by the executor');
        assert.equal('createTask' in reader,false); assert.equal('db' in reader,false);
    } finally {reader.close();writer.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('desktop opening and reads do not initialise, migrate or change saved database bytes',()=>{
    const {dir,file,writer}=fixture();writer.close();const before=hash(file),observer=new DatabaseSync(file,{readOnly:true}),version=observer.prepare('PRAGMA data_version').get().data_version;
    try {
        const reader=openWorkbenchReadStore(file);try{reader.get('first');reader.getContract('first');reader.reviews.list('first');reader.workspaceProtection.readView('first');}finally{reader.close();}
        assert.equal(hash(file),before);assert.equal(observer.prepare('PRAGMA data_version').get().data_version,version);
        const missing=path.join(dir,'must-not-create.sqlite');assert.throws(()=>openWorkbenchReadStore(missing));assert.equal(fs.existsSync(missing),false);
    } finally {observer.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('saved review corruption is rejected and damaged scope does not become missing or passed',()=>{
    const {dir,file,writer}=fixture(),reader=openWorkbenchReadStore(file);
    try {
        const review={reviewId:'review-1',taskId:'first',attemptId:'old',checks:[]};
        writer.db.prepare('INSERT INTO task_review_records VALUES(?,?,?,?,?)').run('review-1','first','review',operationDigest(review),JSON.stringify(review));
        assert.deepEqual(reader.reviews.list('first'),writer.reviews.list('first'));
        writer.db.prepare('INSERT INTO task_review_records VALUES(?,?,?,?,?)').run('review-corrupt','first','review','bad',JSON.stringify(review));
        assert.throws(()=>reader.reviews.list('first'));
        writer.db.prepare('INSERT INTO workspace_scope_baselines VALUES(?,?,?)').run('first','wrong','{}');
        assert.equal(reader.workspaceProtection.readView('first').baseline,'integrity_failure');
    } finally {reader.close();writer.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('desktop host reads changed saved facts and exits when its owning stdin closes',{timeout:20000},async()=>{
    const {dir,file,writer}=fixture();
    const child=spawn(process.execPath,['scripts/workbench-desktop-host.mjs'],{cwd:path.resolve(import.meta.dirname,'../..'),env:{...process.env,WORKBUDDY_DB_FILE:file,WORKBUDDY_RUNS_DIR:path.join(dir,'runs'),WORKBUDDY_CLI_ELECTRON:path.join(dir,'not-an-executor.exe'),WORKBUDDY_CONFIG_DIR:path.join(dir,'config')},stdio:['pipe','pipe','pipe']});
    let errors='';child.stderr.on('data',chunk=>{errors+=chunk});
    const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    try {
        const line=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('host readiness timeout: '+errors)),8000);child.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n')){clearTimeout(timer);resolve(text.split('\n')[0]);}});child.once('error',reject);});
        const ready=JSON.parse(line),url='http://127.0.0.1:'+ready.port;
        assert.equal(ready.event,'desktop_host_ready');
        let response=await fetch(url+'/workbench/v1/panel/tasks/first');assert.equal(response.status,200);assert.equal((await response.json()).presentation.objective,'Saved task first');
        writer.db.prepare('UPDATE tasks SET objective=? WHERE task_id=?').run('New saved snapshot','first');
        response=await fetch(url+'/workbench/v1/panel/tasks/first');assert.equal((await response.json()).presentation.objective,'New saved snapshot');
        response=await fetch(url+'/workbench/v1/panel/tasks/first',{method:'POST'});assert.equal(response.status,405);
        child.stdin.end();const result=await exited;assert.equal(result.code,0);
    } finally {if(child.exitCode===null)child.kill();await exited;writer.close();fs.rmSync(dir,{recursive:true,force:true});}
});
