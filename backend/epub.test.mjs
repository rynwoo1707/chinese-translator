import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,strToU8} from 'fflate';
import {extractEpub} from './epub.js';
export function sampleEpub(extra={}){return zipSync(Object.fromEntries(Object.entries({
 mimetype:'application/epub+zip',
 'META-INF/container.xml':'<container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
 'OPS/book.opf':'<package><metadata><dc:title xmlns:dc="urn:dc">测试小说</dc:title></metadata><manifest><item id="one" href="text/z.xhtml" media-type="application/xhtml+xml"/><item id="two" href="text/a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
 'OPS/text/a.xhtml':'<html><body><h1>第二章</h1><p>她轻声说：“新的一天开始了。”</p></body></html>',
 'OPS/text/z.xhtml':'<html><head><title>Không lấy title</title></head><body><h1>第一章</h1><p>清晨，阳光照进房间。</p><p>你好&nbsp;世界 &amp; 朋友。</p><script>bad()</script><style>badcss</style></body></html>',
 ...extra
 }).map(([name,text])=>[name,strToU8(text)])));}
test('EPUB uses spine order, preserves paragraphs and decodes text entities',()=>{
 const result=extractEpub(sampleEpub());assert.equal(result.chapterCount,2);assert.equal(result.title,'测试小说');assert.ok(result.source.indexOf('第一章')<result.source.indexOf('第二章'));assert.match(result.source,/你好\u00a0世界 & 朋友/);assert.doesNotMatch(result.source,/bad\(\)|badcss|Không lấy title/);assert.match(result.source,/第一章\n\n清晨/);
});
test('EPUB rejects encrypted chapter text, missing chapters and image-only books',()=>{
 assert.throws(()=>extractEpub(sampleEpub({'META-INF/encryption.xml':'<encryption><EncryptedData><CipherData><CipherReference URI="OPS/text/z.xhtml"/></CipherData></EncryptedData></encryption>'})),/DRM/);
 assert.throws(()=>extractEpub(sampleEpub({'OPS/book.opf':'<package><manifest/><spine><itemref idref="missing"/></spine></package>'})),/thiếu chương/);
 assert.throws(()=>extractEpub(sampleEpub({'OPS/text/z.xhtml':'<html><body><img src="cover.jpg"/></body></html>','OPS/text/a.xhtml':'<html><body><img src="p.jpg"/></body></html>'})),/không có chương văn bản/);
});
test('EPUB marks image-only sections without losing the rest of the book',()=>{
 const result=extractEpub(sampleEpub({'OPS/text/z.xhtml':'<html><body><img src="cover.jpg"/></body></html>'}));assert.equal(result.chapterCount,2);assert.ok(result.warnings.length);assert.match(result.source,/第二章/);
});
