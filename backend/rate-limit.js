// Two kinds of limit. The Workers rate-limit bindings (AUTH_LIMITER, HEAVY_LIMITER, API_LIMITER) count per minute
// and per Cloudflare location, a loose filter against floods. Daily caps count in D1. (One PDF call at a time per
// account and the service's site-wide slots are leases, in pdf-slots.js.) All fail open: a missing binding (tests,
// wrangler dev without it) or a storage error never blocks a student. Keys are per account wherever there is one: a
// whole school can share one IP address, so only registration, login and browser error reports count per address
// (clientIp: an IPv6 network by its /64). Wrong passwords are counted apart, in reader-auth.js (table auth_failures).
import {json,logEvent} from './http.js';

const DAY=86400000,VIETNAM=7*3600000;
// Day number in Vietnam time, so every cap resets at midnight there.
export const vietnamDay=(now=Date.now())=>Math.floor((now+VIETNAM)/DAY);
export const secondsToReset=(now=Date.now())=>Math.max(1,Math.ceil(((vietnamDay(now)+1)*DAY-VIETNAM-now)/1000));
export const TOO_FAST='Bạn thao tác quá nhanh. Hãy đợi khoảng một phút rồi thử lại.';
export const dailyMessage=(max,label)=>`Bạn đã dùng hết ${max} lượt ${label} hôm nay. Hạn mức được đặt lại lúc 0:00 (giờ Việt Nam).`;
// extra: fields the answer adds, e.g. scope ('network': a limit the whole network shares; 'failures': wrong passwords).
export const tooMany=(seconds,message,extra={})=>json({error:message,code:'rate_limited',retryAfter:seconds,...extra},429,{'Retry-After':String(seconds)});

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
// Checks run in order and the first that trips answers: {binding,key} per minute, or {daily,max,label} per day. A check
// may bring its own message, and a scope the answer carries.
export async function rateLimit(env,checks){
 for(const check of checks){
  const extra=check.scope?{scope:check.scope}:{};
  if(check.daily){if(await overDailyCap(env,check.daily,check.max))return tooMany(secondsToReset(),check.message||dailyMessage(check.max,check.label),extra);}
  else if(await limited(env,check.binding,check.key))return tooMany(60,check.message||TOO_FAST,extra);
 }
 return null;
}
