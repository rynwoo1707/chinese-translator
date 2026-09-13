import test from 'node:test';
import assert from 'node:assert/strict';
import {azw3HtmlToText,extractAzw3} from './azw3.js';

test('AZW3 chapter HTML becomes clean translatable text',()=>{const text=azw3HtmlToText('<html><head><style>bad</style></head><body><h1>第一章</h1><p>清晨&nbsp;开始。</p><script>bad()</script></body></html>');assert.match(text,/第一章\n\n清晨 开始。/);assert.doesNotMatch(text,/bad/);});
test('AZW3 extractor rejects files without a Kindle BOOKMOBI signature',async()=>{await assert.rejects(()=>extractAzw3(new Uint8Array(100)),/không phải AZW3/);});
