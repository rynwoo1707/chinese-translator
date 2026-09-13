import test from 'node:test';
import assert from 'node:assert/strict';
import {previewWebSource,webImportInternals} from './web-import.js';

const entry=(title,content,url,date='2026-01-01T00:00:00Z')=>({title:{$t:title},content:{$t:content},published:{$t:date},link:[{rel:'alternate',href:url}]});

test('Web importer rejects arbitrary hosts and non-label paths',async()=>{
 await assert.rejects(()=>previewWebSource('https://example.com/search/label/ax1'),/chỉ hỗ trợ/);
 await assert.rejects(()=>previewWebSource('https://www.truyenxin.top/'),/đường dẫn danh mục/);
});

test('Web importer extracts readable chapter text and preserves order',()=>{
 const json={feed:{entry:[
  entry('Tên truyện - Chương 2','<p>Đoạn hai<br>Xuống dòng</p><script>bad()</script>','https://www.truyenxin.top/c2','2026-01-02T00:00:00Z'),
  entry('Tên truyện - Chương 1','<h2>Chương 1</h2><p>Nội dung&nbsp; đầu.</p>','https://www.truyenxin.top/c1')
 ]}};
 const chapters=webImportInternals.parseEntries(json,'ax1');
 assert.deepEqual(chapters.map(chapter=>chapter.title),['Tên truyện - Chương 1','Tên truyện - Chương 2']);
 assert.equal(chapters[0].content,'Chương 1\n\nNội dung đầu.');
 assert.equal(chapters[1].content,'Đoạn hai\n\nXuống dòng');
 assert.equal(webImportInternals.cleanSeriesTitle(chapters[0].title),'Tên truyện');
});

test('Series preview uses the public Blogger feed without rendering source HTML',async t=>{
 t.mock.method(globalThis,'fetch',async url=>{
  assert.match(String(url),/^https:\/\/www\.truyenxin\.top\/feeds\/posts\/default\/-\/ax7\?/);
  return Response.json({feed:{entry:[entry('Bộ thử - Chương 1','<p>Nội dung truyện</p>','https://www.truyenxin.top/bai-thu')]}});
 });
 const data=await previewWebSource('https://www.truyenxin.top/search/label/ax7');
 assert.equal(data.type,'series');assert.equal(data.series.title,'Bộ thử');assert.equal(data.series.chapters[0].characters,15);
});
