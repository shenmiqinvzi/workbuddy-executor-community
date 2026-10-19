import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// Captured at process boot: deploying files never upgrades an old process's identity.
const root = path.dirname(fileURLToPath(import.meta.url));
function files(dir:string):string[] { return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):e.name.endsWith(".js")?[path.join(dir,e.name)]:[]).sort(); }
const hash = crypto.createHash("sha256");
for (const file of files(root)) hash.update(path.relative(root,file).replaceAll("\\","/")).update(fs.readFileSync(file));
export const runtimeVersion = Object.freeze({release:"portability-20261018.1",packageVersion:JSON.parse(fs.readFileSync(path.join(root,"..","package.json"),"utf8")).version as string,pid:process.pid,startedAt:new Date().toISOString(),codeHash:hash.digest("hex")});
