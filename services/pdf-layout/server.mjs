import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {pythonOperation,renderDocument,fontCss} from './engine.mjs';
import {validateLayoutDocument} from '../../frontend/pdf-box-layout.js';

const token=process.env.PDF_LAYOUT_SERVICE_TOKEN;if(!token||token.length<24)throw new Error('Đặt PDF_LAYOUT_SERVICE_TOKEN tối thiểu 24 ký tự.');
const authorized=req=>{const actual=Buffer.from(req.headers.authorization||''),expected=Buffer.from(`Bearer ${token}`);return actual.length===expected.length&&timingSafeEqual(actual,expected);};
let active=0;
const server=createServer(async(req,res)=>{
 const json=(body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
 if(!authorized(req))return json({error:'Unauthorized'},401);
 if(req.url==='/health'&&req.method==='GET')return json({ok:true,engine:'pymupdf-puppeteer',busy:active>0});
 if(req.url==='/font'&&req.method==='GET'){try{return json({css:await fontCss()});}catch(error){return json({error:error.message},500);}}
 if(req.method!=='POST'||!['/extract','/render'].includes(req.url))return json({error:'Not found'},404);
 if(active>=2)return json({error:'Dịch vụ PDF đang bận. Hãy thử lại sau.'},503);
 active++;
 try{
  const rawPdf=req.headers['content-type']==='application/pdf',chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>(rawPdf?25:40)*1024*1024)throw new Error('Dữ liệu PDF vượt giới hạn.');chunks.push(chunk);}const bytes=Buffer.concat(chunks),payload=rawPdf?{pdfBase64:bytes.toString('base64'),pages:decodeURIComponent(req.headers['x-pdf-pages']||'')}:JSON.parse(bytes.toString('utf8'));
  if(req.url==='/extract'){const result=await pythonOperation(payload);validateLayoutDocument(result.document);json(result);}
  else json(await renderDocument(payload.document,payload.translations,{title:payload.title}));
 }catch(error){console.error(`[pdf-layout] ${req.url} ${error.message}`);json({error:error.message},422);}finally{active--;}
});
server.requestTimeout=300000;server.listen(Number(process.env.PORT)||8091,process.env.PDF_LAYOUT_HOST||'127.0.0.1',()=>console.log('PDF layout service ready (PyMuPDF + Puppeteer).'));
