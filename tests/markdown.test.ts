// The security-relevant tests: card and model text is untrusted, and this is the
// only thing standing between it and dangerouslySetInnerHTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../web/markdown.ts';

test('raw HTML is escaped, not rendered', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script'), html);
  assert.ok(html.includes('&lt;script&gt;'), html);
});

test('an image with an inline handler cannot get through', () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">');
  assert.ok(!/<img[^>]*onerror/i.test(html), html);
  assert.ok(!html.includes('<img src=x'), html);
});

test('an iframe is escaped', () => {
  const html = renderMarkdown('<iframe src="https://example.com"></iframe>');
  assert.ok(!html.includes('<iframe'), html);
});

test('javascript: links are stripped, leaving only the text', () => {
  const html = renderMarkdown('[click me](javascript:alert(1))');
  assert.ok(!html.includes('javascript:'), html);
  assert.ok(!html.includes('<a '), html);
  assert.ok(html.includes('click me'), html);
});

test('data: and vbscript: links are stripped too', () => {
  for (const href of ['data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox(1)', ' JAVASCRIPT:alert(1)']) {
    const html = renderMarkdown(`[x](${href})`);
    assert.ok(!html.includes('<a '), `${href} produced a link: ${html}`);
  }
});

test('http, https and mailto links are allowed and open safely', () => {
  const html = renderMarkdown('[site](https://example.com) and [mail](mailto:a@b.com)');
  assert.ok(html.includes('href="https://example.com"'), html);
  assert.ok(html.includes('href="mailto:a@b.com"'), html);
  assert.ok(html.includes('rel="noopener noreferrer"'), html);
  assert.ok(html.includes('target="_blank"'), html);
});

test('an image with a javascript source falls back to its alt text', () => {
  const html = renderMarkdown('![a picture](javascript:alert(1))');
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('a picture'), html);
});

test('an https image is kept, with its alt text escaped', () => {
  const html = renderMarkdown('![<b>alt</b>](https://example.com/a.png)');
  assert.ok(html.includes('src="https://example.com/a.png"'), html);
  assert.ok(!html.includes('<b>'), html);
});

test('quoted dialogue is wrapped for highlighting', () => {
  const html = renderMarkdown('"You came back," she said.');
  assert.ok(html.includes('class="rp-quote"'), html);
  assert.ok(html.includes('You came back,'), html);
});

test('curly quotes are highlighted as well', () => {
  const html = renderMarkdown('“You came back,” she said.');
  assert.ok(html.includes('class="rp-quote"'), html);
});

test('markdown inside dialogue still renders', () => {
  const html = renderMarkdown('"I *mean* it."');
  assert.ok(html.includes('class="rp-quote"'), html);
  assert.ok(html.includes('<em>mean</em>'), html);
});

test('actions in asterisks become emphasis', () => {
  assert.ok(renderMarkdown('*she looks up*').includes('<em>she looks up</em>'));
});

test('an unclosed quote is left alone rather than swallowing the message', () => {
  const html = renderMarkdown('"unclosed quote here');
  assert.ok(!html.includes('class="rp-quote"'), html);
  assert.ok(html.includes('unclosed quote here'), html);
});

test('empty input renders to nothing', () => {
  assert.equal(renderMarkdown('').trim(), '');
});

test('quotes and apostrophes are typeset, not typewritten', () => {
  const html = renderMarkdown(`"It's late," she says. 'Fine.' The dogs' bowls.`);
  assert.ok(html.includes('“It’s late,”'), html);
  assert.ok(html.includes('‘Fine.’'), html);
  assert.ok(html.includes('dogs’ bowls'), html);
});

test('code keeps its straight quotes', () => {
  const html = renderMarkdown('`a = "b"`');
  assert.ok(html.includes('&quot;b&quot;'), html);
});
