// GET|HEAD /api/health for uptime checks and the deploy script: is the database reachable, which version is live.
// It never needs a login and never shows a secret, a URL or an error text.
import {json,logEvent} from './http.js';

export async function healthRoute(request,env,path){
 if(path!=='/api/health')return null;
 if(!['GET','HEAD'].includes(request.method))return json({error:'Phương thức không được hỗ trợ.'},405,{Allow:'GET, HEAD'});
 let database='ok';
 try{if(typeof env.DB?.prepare!=='function'||!await env.DB.prepare('SELECT 1 AS ok').first())database='error';}
 catch(error){database='error';logEvent('health_db_error',{name:error?.name,message:String(error?.message||'').slice(0,200)});}
 // Set by the version_metadata binding: tag is what the deploy script passes (the commit), id the Cloudflare version.
 const meta=env.CF_VERSION_METADATA||{},status=database==='ok'?200:503;
 const body={ok:database==='ok',service:'hoa-tri',version:meta.tag||meta.id||'dev',deployedAt:meta.timestamp||null,database,pdfLayout:env.PDF_LAYOUT_SERVICE_URL&&env.PDF_LAYOUT_SERVICE_TOKEN?'configured':'off',time:new Date().toISOString()};
 return request.method==='HEAD'?new Response(null,{status,headers:{'Cache-Control':'no-store'}}):json(body,status);
}
