import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {assertInsideSamples} from './paths.mjs';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const fileSha256=async path=>existsSync(path)?sha256(await readFile(path)):null;
export async function readJson(path,{what=path}={}){
 let text;try{text=await readFile(path,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}
 try{return JSON.parse(text.replace(/^﻿/u,''));}catch(error){throw new Error(`${what} không phải JSON hợp lệ: ${error.message}`);}
}
// Every write of the tool goes through here: inside samples/ only, written whole then renamed, so an interrupted run
// never leaves half a manifest or report behind.
export async function writeSampleFile(path,data){
 assertInsideSamples(path);await mkdir(dirname(path),{recursive:true});
 const temporary=`${path}.${process.pid}.tmp`;await writeFile(temporary,data);await rename(temporary,path);
}
export const writeJson=(path,value)=>writeSampleFile(path,JSON.stringify(value,null,1)+'\n');
// Files a translator reads (blocks.json, texts.template.json): one line per key, and one line per entry of a list of
// objects, so a block's fields stay together instead of spreading over dozens of lines.
export const compactJson=value=>`{\n${Object.entries(value).map(([key,item])=>` ${JSON.stringify(key)}: ${Array.isArray(item)&&item.some(x=>x&&typeof x==='object')?`[\n${item.map(x=>`  ${JSON.stringify(x)}`).join(',\n')}\n ]`:JSON.stringify(item)}`).join(',\n')}\n}\n`;
export const writeCompactJson=(path,value)=>writeSampleFile(path,compactJson(value));
// Machine files with embedded images (manifests) stay on one line.
export const writeRawJson=(path,value)=>writeSampleFile(path,JSON.stringify(value));
export async function removeSamplePath(path){assertInsideSamples(path);await rm(path,{recursive:true,force:true});}
export const dataUrlBytes=url=>Buffer.from(String(url).slice(String(url).indexOf(',')+1),'base64');
export const isPdf=bytes=>Buffer.from(bytes.subarray(0,5)).toString('latin1')==='%PDF-';
