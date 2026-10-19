// Three kinds of limit. The Workers rate-limit bindings (AUTH_LIMITER, HEAVY_LIMITER, API_LIMITER) count per minute
// and per Cloudflare location, a loose filter against floods. Daily caps count in D1. Leases (D1) let one call at a
// time hold a key. All fail open: a missing binding (tests, wrangler dev without it) or a storage error never blocks a
// student. Keys are per account wherever there is one: a whole school can share one IP address, so only registration
// and login count per address (clientIp: an IPv6 network by its /64).
import {json,logEvent} from './http.js';

const DAY=86400000,VIETNAM=7*3600000;
// Day number in Vietnam time, so every cap resets at midnight there.
export const vietnamDay=(now=Date.now())=>Math.floor((now+VIETNAM)/DAY);
export const secondsToReset=(now=Date.now())=>Math.max(1,Math.ceil(((vietnamDay(now)+1)*DAY-VIETNAM-now)/1000));
export const TOO_FAST='Bạn thao tác quá nhanh. Hãy đợi khoảng một phút rồi thử lại.';
export const dailyMessage=(max,label)=>`Bạn đã dùng hết ${max} lượt ${label} hôm nay. Hạn mức được đặt lại lúc 0:00 (giờ Việt Nam).`;
export const tooMany=(seconds,message)=>json({error:message,code:'rate_limited',retryAfter:seconds},429,{'Retry-After':String(seconds)});

export async function limited(env,binding,key){
 const limiter=env?.[binding];if(typeof limiter?.limit!=='function')return false;
 try{return (await limiter.limit({key}))?.success===false;}
 catch(error){logEvent('rate_limit_error',{binding,name:error?.name,message:String(error?.message||'').slice(0,200)});return false;}
}
// Counts one use of key today and reports whether that went past max. The row is reset by the first use on a new day.
export async function overDailyCap(env,key,max,now=Date.now()){
 if(!max||typeof env?.DB?.prepare!=='function')return false;
 const day=vietnamDay(now);
 try{
  const row=await env.DB.prepare('INSERT INTO rate_limits(key,window_start,count) VALUES(?1,?2,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.window_start=excluded.window_start THEN rate_limits.count+1 ELSE 1 END,window_start=excluded.window_start RETURNING count').bind(key,day).first(),count=Number(row?.count)||0;
  // A key's first use of the day also clears every finished day: those counts would restart anyway, and a registration
  // key holds an IP address, so none is kept much past its day.
  if(count===1)await env.DB.prepare('DELETE FROM rate_limits WHERE window_start<?').bind(day).run();
  return count>max;
 }catch(error){logEvent('rate_limit_error',{table:'rate_limits',name:error?.name,message:String(error?.message||'').slice(0,200)});return false;}
}
// A cap from an optional var (a whole number; 0 turns the cap off), else the default.
export function dailyMax(env,name,fallback){const value=String(env?.[name]??'').trim();return /^\d{1,7}$/u.test(value)?Number(value):fallback;}
// Takes key for at most ms (table service_leases, migration 0018): {release} when it was free or its holder's time ran
// out (a Worker that stopped mid-call never released it), null while another call holds it. Release only frees the
// lease this call took, never a newer one taken after it ran out.
const NO_LEASE={release:async()=>{}};
export async function takeLease(env,key,ms,now=Date.now()){
 if(typeof env?.DB?.prepare!=='function')return NO_LEASE;
 const token=crypto.randomUUID();
 try{
  const row=await env.DB.prepare('INSERT INTO service_leases(key,token,expires_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE service_leases.expires_at<=?4 RETURNING token').bind(key,token,now+ms,now).first();
  if(!row)return null;
 }catch(error){logEvent('lease_error',{table:'service_leases',name:error?.name,message:String(error?.message||'').slice(0,200)});return NO_LEASE;}
 return {release:async()=>{try{await env.DB.prepare('DELETE FROM service_leases WHERE key=? AND token=?').bind(key,token).run();}catch(error){logEvent('lease_error',{table:'service_leases',name:error?.name,message:String(error?.message||'').slice(0,200)});}}};
}
// Checks run in order and the first that trips answers: {binding,key} per minute, or {daily,max,label} per day.
export async function rateLimit(env,checks){
 for(const check of checks){
  if(check.daily){if(await overDailyCap(env,check.daily,check.max))return tooMany(secondsToReset(),dailyMessage(check.max,check.label));}
  else if(await limited(env,check.binding,check.key))return tooMany(60,TOO_FAST);
 }
 return null;
}
