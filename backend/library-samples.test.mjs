import test from 'node:test';
import assert from 'node:assert/strict';
import {isSample,sampleBadge,sampleCardNote,sampleReaderNotice,SAMPLE_LABEL} from '../frontend/library-samples.js';
import {bilingualSource,nextZoom,ZOOMS} from '../frontend/bilingual-reader.js';

const SHA='a'.repeat(64);

test('"Ví dụ mẫu": flagged by the server field or a sample: source, never by anything else',()=>{
 for(const flag of [1,true,'1'])assert.equal(isSample({sample:flag}),true,String(flag));
 assert.equal(isSample({source_url:'sample:ham-so'}),true);
 for(const item of [null,undefined,{},{sample:0},{sample:false},{sample:'0'},{source_url:'study-book:x'},{source_url:'https://example.test/sample:x'}])assert.equal(isSample(item),false,JSON.stringify(item));
 assert.equal(sampleBadge({sample:0}),'');assert.equal(sampleBadge({sample:1}),`<span class="sample-badge">${SAMPLE_LABEL}</span>`);
});

test('Sample card note, library intro and reader notice say the translation is AI-made and not reviewed',()=>{
 assert.equal(sampleCardNote({sample:0,translated_pages:4}),'');
 const note=sampleCardNote({sample:1,translated_pages:'4'});
 assert.equal(note,'<p class="sample-card-note">AI dịch · chưa qua giáo viên duyệt</p>','one muted line: AI-made, not reviewed');
 assert.equal(sampleCardNote({sample:1}),note,'the same line with or without a page count');
 assert.equal(sampleReaderNotice({sample:0},{mime:'application/pdf'}),'');
 const pdf=sampleReaderNotice({id:'s1',sample:true},{mime:'application/pdf',source_sha256:SHA,source_pages:[5,6]});
 assert.equal(pdf,'<aside class="note sample-notice" role="note"><strong>Ví dụ mẫu.</strong> AI dịch, chưa qua giáo viên duyệt; hãy đối chiếu bản gốc.</aside>');assert.doesNotMatch(pdf,/<a /u);
 // A text part does not claim a page layout; a part flagged by /api/read alone is enough.
 assert.match(sampleReaderNotice({id:'s1'},{sample:1,mime:'text/plain'}),/AI dịch, chưa qua giáo viên duyệt; hãy đối chiếu bản gốc\./u);
});

test('Đọc song ngữ: a part has an original only with a PDF, page numbers and a stored file of the same hash',()=>{
 const part={id:'c1',mime:'application/pdf',pages:[3,4],sha256:SHA,filename:'goc.pdf',totalPages:9};
 const assembly={parts:[part,{id:'c2',mime:'text/plain',pages:[5],sha256:SHA}],storedSources:[{sha256:SHA,pages:12,url:`/api/my/study/sources/${SHA}`}]};
 assert.deepEqual(bilingualSource(assembly,'c1'),{url:`/api/my/study/sources/${SHA}`,sha256:SHA,pages:[3,4],totalPages:12,filename:'goc.pdf'});
 assert.equal(bilingualSource(assembly,'c2'),null,'a text part has no page to show');
 assert.equal(bilingualSource(assembly,'missing'),null);
 for(const change of [{pages:null},{pages:[]},{pages:[0,1]},{pages:[1.5]},{sha256:'abc'},{sha256:null},{mime:'application/epub+zip'}])assert.equal(bilingualSource({...assembly,parts:[{...part,...change}]},'c1'),null,JSON.stringify(change));
 assert.equal(bilingualSource({...assembly,storedSources:[]},'c1'),null,'an original the server does not keep');
 assert.equal(bilingualSource({...assembly,storedSources:[{sha256:SHA,url:'https://elsewhere.test/x.pdf'}]},'c1'),null,'only same-site API files are opened');
 assert.equal(bilingualSource({...assembly,storedSources:[{sha256:SHA,pages:null,url:'/api/library/b/sources/x'}]},'c1').totalPages,9);
 for(const broken of [null,undefined,{},{parts:'x'},{parts:[null]}])assert.equal(bilingualSource(broken,'c1'),null);
});

test('Đọc song ngữ: zoom steps stay inside the list',()=>{
 assert.equal(nextZoom(1,1),1.25);assert.equal(nextZoom(1,-1),.75);assert.equal(nextZoom(ZOOMS.at(-1),1),ZOOMS.at(-1));assert.equal(nextZoom(ZOOMS[0],-1),ZOOMS[0]);
 assert.equal(nextZoom(1.1,1),1.25,'an odd value moves to the next step');assert.equal(nextZoom(1.1,-1),1);
});
