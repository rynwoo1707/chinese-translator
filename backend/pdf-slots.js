// Who may use the PDF layout service now. The service runs a few jobs at once for the whole site (PDF_LAYOUT_JOBS
// there, PDF_LAYOUT_SLOTS here, default 2), and one job can take minutes. Every extraction, refresh and export holds:
//  - its account's lease 'pdf:<user id>': one call per account at a time, so one account never holds two slots;
//  - one of the site's slots 'pdf-slot:0' … 'pdf-slot:<N-1>': when all are taken the call is answered at once (503
//    pdf_service_busy with Retry-After) instead of reaching a full service.
// Leases are rows of service_leases (migration 0018) that run out after LEASE_TTL_MS and are renewed while the call
// runs. A call whose Worker stops (Cloudflare cancels a request whose browser left; the service then stops the job too)
// stops renewing, so its account and slot are free again within a minute instead of after the longest possible call.
// Like every limit here they fail open: without D1 (tests, wrangler dev without it) or on a storage error the call goes
// ahead, and the service's own limit still answers busy.
import {logEvent} from './http.js';

export const LEASE_TTL_MS=60000,RENEW_MS=20000;
export function slotCount(env){const text=String(env?.PDF_LAYOUT_SLOTS??'').trim();return /^\d{1,2}$/u.test(text)&&Number(text)>=1?Number(text):2;}
const failed=error=>logEvent('lease_error',{table:'service_leases',name:error?.name,message:String(error?.message||'').slice(0,200)});
const NO_LEASE=Object.freeze({renew:async()=>true,release:async()=>{}});
// Takes key when it is free or its holder stopped renewing: {renew,release}; null while another call holds it.
// renew() answers false once another call has taken the key; release() frees only this call's lease, never a newer one.
export async function holdLease(env,key,{ttl=LEASE_TTL_MS,now=Date.now}={}){
 if(typeof env?.DB?.prepare!=='function')return NO_LEASE;
 const token=crypto.randomUUID();
 try{
  const row=await env.DB.prepare('INSERT INTO service_leases(key,token,expires_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE service_leases.expires_at<=?4 RETURNING token').bind(key,token,now()+ttl,now()).first();
  if(!row)return null;
 }catch(error){failed(error);return NO_LEASE;}
 return {
  async renew(){try{const result=await env.DB.prepare('UPDATE service_leases SET expires_at=? WHERE key=? AND token=?').bind(now()+ttl,key,token).run();return Number(result?.meta?.changes??1)>0;}catch(error){failed(error);return true;}},
  async release(){try{await env.DB.prepare('DELETE FROM service_leases WHERE key=? AND token=?').bind(key,token).run();}catch(error){failed(error);}}
 };
}
// One of the site's slots, or null when every one is held.
export async function takeSlot(env,options){
 for(let slot=0;slot<slotCount(env);slot++){const lease=await holdLease(env,`pdf-slot:${slot}`,options);if(lease)return lease;}
 return null;
}
// Runs work while renewing leases every `every` ms; a lease lost meanwhile is only logged (the call goes on), and a
// renewal still on its way when the work ends is not.
export async function keepRenewed(leases,work,{every=RENEW_MS}={}){
 let done=false;
 const timer=setInterval(()=>{for(const lease of leases)lease.renew().then(held=>{if(!held&&!done)logEvent('lease_lost',{table:'service_leases'});},()=>{});},every);
 try{return await work();}finally{done=true;clearInterval(timer);}
}
