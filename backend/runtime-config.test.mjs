import test from 'node:test';
import assert from 'node:assert/strict';
import {saveGeminiApiKey,clearGeminiApiKey,runtimeGeminiApiKey,geminiKeyStatus,withRuntimeGeminiKey,runtimeConfigInternals} from './runtime-config.js';

function environment(overrides={}){
 const objects=new Map();
 const env={ADMIN_TOKEN:'admin-secret',GEMINI_API_KEY:'environment-key',FILES:{
  async put(key,value){objects.set(key,String(value));},
  async get(key){const value=objects.get(key);return value===undefined?null:{async json(){return JSON.parse(value);}};},
  async delete(key){objects.delete(key);}
 },...overrides};
 return {env,objects};
}

test('Gemini key saved from dashboard is encrypted and used at runtime',async()=>{
 const {env,objects}=environment(),secret='AIza-example-secret-value-123456';
 const saved=await saveGeminiApiKey(env,secret);
 assert.equal(saved.source,'dashboard');
 const raw=objects.get(runtimeConfigInternals.CONFIG_KEY);
 assert.ok(raw);assert.equal(raw.includes(secret),false);
 assert.equal(await runtimeGeminiApiKey(env),secret);
 assert.deepEqual((await geminiKeyStatus(env)).source,'dashboard');
 const runtime=await withRuntimeGeminiKey(env);
 assert.equal(runtime.GEMINI_API_KEY,secret);assert.equal(runtime.FILES,env.FILES);
});

test('Removing dashboard key falls back to server environment',async()=>{
 const {env}=environment();
 await saveGeminiApiKey(env,'AIza-temporary-secret-value-1234');
 const status=await clearGeminiApiKey(env);
 assert.equal(status.source,'environment');assert.equal(status.configured,true);
 assert.equal(await runtimeGeminiApiKey(env),'environment-key');
});

test('Stored key cannot be decrypted with another admin token',async()=>{
 const {env}=environment();
 await saveGeminiApiKey(env,'AIza-temporary-secret-value-1234');
 await assert.rejects(()=>runtimeGeminiApiKey({...env,ADMIN_TOKEN:'different-token'}),/Không giải mã được/);
});

test('Rejects malformed Gemini keys',async()=>{
 const {env}=environment();
 await assert.rejects(()=>saveGeminiApiKey(env,'short'),/không hợp lệ/);
 await assert.rejects(()=>saveGeminiApiKey(env,'valid-looking-key-value\nsecond-line'),/không hợp lệ/);
});
