import test from 'node:test';
import assert from 'node:assert/strict';
import {logEvent,errorResponse} from './http.js';

// logEvent (http.js): one JSON line per event. A problem goes to console.error; an event that went as intended (level
// 'info', such as an admin account created) goes to console.log, so wrangler dev, and with it the start.cmd window, does
// not print it as "X [ERROR] …". Both levels keep the same JSON shape.
function capture(t){
 const lines=[];
 for(const [method,level] of [['error','error'],['log','info'],['warn','warn'],['info','console.info']])t.mock.method(console,method,line=>lines.push([level,line]));
 return lines;
}

test('An event without a level is an error line: one JSON object on console.error',t=>{
 const lines=capture(t);
 logEvent('admin_session_error',{name:'Error',message:'D1_ERROR: storage unavailable'});
 assert.deepEqual(lines,[['error','{"event":"admin_session_error","name":"Error","message":"D1_ERROR: storage unavailable"}']]);
});

test('An info event goes to console.log with the same JSON shape, and nothing reaches console.error',t=>{
 const lines=capture(t);
 logEvent('admin_account',{action:'created_first'},'info');
 assert.deepEqual(lines,[['info','{"event":"admin_account","action":"created_first"}']]);
 // Only 'info' leaves the error stream: an unknown or misspelt level stays an error, so no problem is ever hidden.
 for(const level of ['error','warn','Info',undefined])logEvent('pdf_service_refused',{operation:'extract',status:401},level);
 assert.deepEqual(lines.slice(1).map(([level])=>level),['error','error','error','error']);
 assert.ok(lines.slice(1).every(([,line])=>line==='{"event":"pdf_service_refused","operation":"extract","status":401}'));
});

test('A value JSON cannot write is dropped quietly at either level, never thrown into the request',t=>{
 const lines=capture(t),loop={};loop.self=loop;
 assert.doesNotThrow(()=>logEvent('client_error',{size:1n}));
 assert.doesNotThrow(()=>logEvent('admin_account',{loop},'info'));
 assert.deepEqual(lines,[]);
});

test('An unexpected error of a route is still logged as an error (api_error), with the ray the browser is shown',t=>{
 const lines=capture(t);
 const response=errorResponse(new TypeError('x is not a function'),{request:new Request('https://hoa-tri.example/api/my/study/history',{method:'POST',headers:{'cf-ray':'8f00ab12'}}),url:new URL('https://hoa-tri.example/api/my/study/history'),path:'/api/my/study/history'});
 assert.equal(response.status,500);
 assert.deepEqual(lines.map(([level,line])=>[level,JSON.parse(line)]),[['error',{event:'api_error',method:'POST',route:'/api/my/study/history',name:'TypeError',message:'x is not a function',ray:'8f00ab12'}]]);
});
