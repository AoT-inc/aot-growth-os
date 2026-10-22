// A5 U5: `fetch_url` 도구의 요청 검사 규칙 (소켓을 열지 않는 부분). 스킴·사용자 정보·허용 호스트(운영 설정 ∩ 업무 network_allowlist)·SSRF 주소 검사·인자 규칙·설정 검증.
// 실제 연결이 필요한 시험(리다이렉트·크기·타임아웃·고정된 연결 주소)은 test/integration/fetch-url.test.ts 다.
// 거부는 모두 연결 전에 일어나야 하므로 해석 주입(lookup)이 불린 횟수와 오류 코드를 같이 본다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as publicApi from '@aot/agent-runtime';
import {
  createFetchUrlTool, createSourceFetcher, FETCH_URL_TOOL, fetchUrlToolSpec, FetchUrlError, hostMatches, htmlToText,
  type FetchUrlErrorCode, type JsonObject, type ToolExecutionRequest,
} from '@aot/agent-runtime';

import { createFetchUrlToolWithHooks, createSourceFetcherWithHooks, type FetchUrlHooks } from '../../packages/agent-runtime/src/fetch-url.ts';

/** 규칙을 어긴 구현이 연결을 시도하더라도 시험이 오래 걸리지 않게, 호출마다 새 시간 제한 신호를 기본으로 쓴다 (정상 호출은 수 밀리초에 끝난다) */
const guard = (): AbortSignal => AbortSignal.timeout(3000);

function request(args: JsonObject, networkAllowlist: string[] | undefined, signal: AbortSignal = guard()): ToolExecutionRequest {
  return {
    runId: 'run-1', tool: FETCH_URL_TOOL, operation: 'fetch', args, signal,
    constraints: { max_usd: 1, ...(networkAllowlist === undefined ? {} : { network_allowlist: networkAllowlist }) },
  };
}

async function code(promise: Promise<unknown>): Promise<FetchUrlErrorCode> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof FetchUrlError, `expected a FetchUrlError, got ${String(error)}`);
    return error.code;
  }
  assert.fail('expected the call to be refused');
}

/** 해석 주입: 호스트 → 주소 목록. 불린 호스트를 기록한다 */
function resolver(table: Record<string, string[]>): { hooks: FetchUrlHooks; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    hooks: {
      lookup: (host) => {
        asked.push(host);
        const found = table[host];
        return found === undefined ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve(found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
      },
    },
  };
}

describe('fetch_url: tool declaration', () => {
  it('is a read-only tool whose results are external untrusted input', () => {
    const spec = fetchUrlToolSpec({ unitCost: { usd: 0.001 }, timeoutMs: 5000 });
    assert.deepEqual(spec, {
      tool: 'fetch_url', operation: 'fetch', scope: 'internal', impact: 'read', sideEffect: false, resultOrigin: 'external_untrusted', unitCost: { usd: 0.001 }, timeoutMs: 5000,
    });
    assert.deepEqual(createFetchUrlTool({ allowedHosts: ['example.com'] }).spec, fetchUrlToolSpec());
  });

  it('index.ts does not export the hook-taking constructors (the private-address switch is not an operational setting)', () => {
    const names = Object.keys(publicApi);
    assert.ok(names.includes('createFetchUrlTool') && names.includes('createSourceFetcher'));
    assert.deepEqual(names.filter((name) => /hooks/i.test(name)), [], 'constructors that take test hooks stay out of the public API');
  });
});

describe('fetch_url: configuration is validated when the tool is made', () => {
  it('refuses allow-all and malformed host entries, and out-of-range limits', () => {
    for (const bad of ['*', '', ' ', 'https://example.com', 'example.com/path', 'a*.example.com', '*.', '.example.com', 'user@example.com', 'a b.example.com']) {
      assert.throws(() => createFetchUrlTool({ allowedHosts: [bad] }), /invalid fetch_url configuration/, JSON.stringify(bad));
    }
    assert.throws(() => createFetchUrlTool({ allowedHosts: ['example.com'], maxBodyBytes: 0 }), /maxBodyBytes/);
    assert.throws(() => createFetchUrlTool({ allowedHosts: ['example.com'], maxBodyBytes: 512 * 1024 + 1 }), /maxBodyBytes/);
    assert.throws(() => createFetchUrlTool({ allowedHosts: ['example.com'], maxBodyBytes: 1.5 }), /maxBodyBytes/);
    assert.throws(() => createFetchUrlTool({ allowedHosts: ['example.com'], maxRedirects: -1 }), /maxRedirects/);
    assert.throws(() => createFetchUrlTool({ allowedHosts: ['example.com'], maxRedirects: 11 }), /maxRedirects/);
    assert.throws(() => createFetchUrlTool({ allowedHosts: ['example.com'], allowedContentTypes: ['text'] }), /allowedContentTypes/);
    assert.throws(() => createSourceFetcher({ allowedHosts: ['*'] }), /invalid fetch_url configuration/);
    createFetchUrlTool({ allowedHosts: [], maxBodyBytes: 512 * 1024, maxRedirects: 0 }); // 비어 있어도 만들 수 있다(모두 거부)
  });
});

describe('fetch_url: host allow list matching', () => {
  it('matches exact hosts and *.suffix (subdomains only), case-insensitively, and never matches an empty list', () => {
    assert.equal(hostMatches('example.com', ['example.com']), true);
    assert.equal(hostMatches('EXAMPLE.com.', ['example.com']), true);
    assert.equal(hostMatches('docs.example.com', ['example.com']), false, 'an exact entry does not cover subdomains');
    assert.equal(hostMatches('docs.example.com', ['*.example.com']), true);
    assert.equal(hostMatches('a.b.example.com', ['*.example.com']), true);
    assert.equal(hostMatches('example.com', ['*.example.com']), false, 'the apex is not a subdomain');
    assert.equal(hostMatches('badexample.com', ['*.example.com']), false);
    assert.equal(hostMatches('example.com.evil.test', ['example.com', '*.example.com']), false);
    assert.equal(hostMatches('example.com', []), false);
    assert.equal(hostMatches('example.com', ['*']), false, '"*" is not a pattern');
    assert.equal(hostMatches('127.0.0.1', ['127.0.0.1']), true);
    assert.equal(hostMatches('::1', ['::1']), true);
  });
});

describe('fetch_url: request rules (all refused before any connection)', () => {
  const allowed = ['example.com', '*.example.com', '10.0.0.1', '127.0.0.1', '169.254.169.254', '::1', '::ffff:7f00:1', 'internal.example.test'];

  it('takes only a "url" argument; anything else is refused', async () => {
    const { hooks, asked } = resolver({ 'example.com': ['93.184.216.34'] });
    const tool = createFetchUrlToolWithHooks({ allowedHosts: allowed }, hooks);
    for (const extra of [{ method: 'POST' }, { headers: {} }, { body: 'x' }, { follow: true }, { __proto__: null, timeout: 1 }]) {
      assert.equal(await code(tool.executor(request({ url: 'https://example.com/', ...extra }, allowed))), 'invalid_args', JSON.stringify(extra));
    }
    assert.equal(asked.length, 0);
  });

  it('refuses non-string, empty, over-long and unparseable URLs', async () => {
    const { hooks, asked } = resolver({});
    const tool = createFetchUrlToolWithHooks({ allowedHosts: allowed }, hooks);
    const bad: unknown[] = [undefined, null, 5, ['https://example.com/'], { href: 'https://example.com/' }, '', 'example.com/page', '/relative', 'https://', `https://example.com/${'a'.repeat(2100)}`, 'http://[::1'];
    for (const url of bad) assert.equal(await code(tool.executor(request({ url } as JsonObject, allowed))), 'invalid_url', String(url).slice(0, 40));
    assert.equal(asked.length, 0);
  });

  it('allows only http and https', async () => {
    const { hooks, asked } = resolver({});
    const tool = createFetchUrlToolWithHooks({ allowedHosts: allowed }, hooks);
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/', 'javascript:alert(1)', 'data:text/html,hi', 'ws://example.com/', 'wss://example.com/', 'HTTP-like://example.com', 'about:blank', 'blob:https://example.com/x']) {
      assert.equal(await code(tool.executor(request({ url }, allowed))), 'scheme_not_allowed', url);
    }
    assert.equal(asked.length, 0);
  });

  it('refuses user information in the URL', async () => {
    const { hooks, asked } = resolver({});
    const tool = createFetchUrlToolWithHooks({ allowedHosts: allowed }, hooks);
    for (const url of ['https://user:pass@example.com/', 'https://user@example.com/', 'https://:pass@example.com/', 'http://a:b@127.0.0.1/']) {
      assert.equal(await code(tool.executor(request({ url }, allowed))), 'userinfo_not_allowed', url);
    }
    assert.equal(asked.length, 0);
  });

  it('refuses every host when the operator list is empty, and when the task has no or an empty network_allowlist', async () => {
    const { hooks, asked } = resolver({ 'example.com': ['93.184.216.34'] });
    const none = createFetchUrlToolWithHooks({ allowedHosts: [] }, hooks);
    assert.equal(await code(none.executor(request({ url: 'https://example.com/' }, ['example.com']))), 'host_not_allowed');
    const tool = createFetchUrlToolWithHooks({ allowedHosts: ['example.com'] }, hooks);
    assert.equal(await code(tool.executor(request({ url: 'https://example.com/' }, undefined))), 'host_not_allowed', 'no network_allowlist = no network');
    assert.equal(await code(tool.executor(request({ url: 'https://example.com/' }, []))), 'host_not_allowed', 'empty network_allowlist = no network');
    assert.equal(asked.length, 0);
  });

  it('needs the host on BOTH lists: the task cannot widen the operator list and the operator list does not widen the task', async () => {
    const { hooks, asked } = resolver({ 'example.com': ['93.184.216.34'], 'docs.example.com': ['93.184.216.35'] });
    const tool = createFetchUrlToolWithHooks({ allowedHosts: ['example.com'] }, hooks);
    assert.equal(await code(tool.executor(request({ url: 'https://docs.example.com/' }, ['docs.example.com']))), 'host_not_allowed', 'operator list does not have it');
    assert.equal(await code(tool.executor(request({ url: 'https://example.com/' }, ['docs.example.com']))), 'host_not_allowed', 'task list does not have it');
    assert.equal(await code(tool.executor(request({ url: 'https://evil.test/' }, ['evil.test', 'example.com']))), 'host_not_allowed');
    assert.equal(asked.length, 0, 'the allow list is checked before any DNS lookup');
  });

  it('refuses private, loopback, link-local, metadata and mapped addresses given as IP literals even when the lists allow the literal', async () => {
    const { hooks, asked } = resolver({});
    const tool = createFetchUrlToolWithHooks({ allowedHosts: allowed }, hooks);
    for (const url of [
      'http://127.0.0.1/', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:127.0.0.1]/',
    ]) {
      assert.equal(await code(tool.executor(request({ url }, allowed))), 'address_not_allowed', url);
    }
    assert.equal(asked.length, 0, 'IP literals are judged without DNS');
  });

  it('normalizes alternative IPv4 spellings (decimal, hex, octal, short) before judging: still refused', async () => {
    const { hooks } = resolver({});
    const list = ['2130706433', '0x7f000001', '017700000001', '127.1', '0177.0.0.1', '127.0.0.1.', '0x7f.0.0.1'];
    const tool = createFetchUrlToolWithHooks({ allowedHosts: ['127.0.0.1'] }, hooks);
    for (const host of list) {
      const url = `http://${host}/`;
      const result = await code(tool.executor(request({ url }, ['127.0.0.1'])));
      assert.ok(result === 'address_not_allowed' || result === 'host_not_allowed', `${url} -> ${result}`);
    }
    const open = createFetchUrlToolWithHooks({ allowedHosts: ['127.0.0.1'] }, hooks);
    assert.equal(await code(open.executor(request({ url: 'http://2130706433/' }, ['127.0.0.1']))), 'address_not_allowed', 'the URL parser turns 2130706433 into 127.0.0.1');
  });

  it('refuses a name that resolves to a non-public address — also when only one of several answers is private', async () => {
    const r = resolver({
      'internal.example.test': ['10.1.2.3'], 'meta.example.test': ['169.254.169.254'], 'loop.example.test': ['127.0.0.1'], 'v6loop.example.test': ['::1'],
      'mapped.example.test': ['::ffff:7f00:1'], 'ula.example.test': ['fd00::1'], 'mixed.example.test': ['93.184.216.34', '10.0.0.5'], 'mixed6.example.test': ['2606:4700::1111', 'fe80::1'],
    });
    const hosts = ['internal.example.test', 'meta.example.test', 'loop.example.test', 'v6loop.example.test', 'mapped.example.test', 'ula.example.test', 'mixed.example.test', 'mixed6.example.test'];
    const tool = createFetchUrlToolWithHooks({ allowedHosts: ['*.example.test'] }, r.hooks);
    for (const host of hosts) assert.equal(await code(tool.executor(request({ url: `http://${host}/` }, ['*.example.test']))), 'address_not_allowed', host);
    assert.deepEqual(r.asked, hosts, 'each name was resolved exactly once');
  });

  it('refuses names that do not resolve or resolve to nothing (dns_failed), and the source fetcher reports them as unreachable', async () => {
    const r = resolver({ 'empty.example.test': [] });
    const tool = createFetchUrlToolWithHooks({ allowedHosts: ['*.example.test'] }, r.hooks);
    assert.equal(await code(tool.executor(request({ url: 'http://missing.example.test/' }, ['*.example.test']))), 'dns_failed');
    assert.equal(await code(tool.executor(request({ url: 'http://empty.example.test/' }, ['*.example.test']))), 'dns_failed');
    const fetcher = createSourceFetcherWithHooks({ allowedHosts: ['*.example.test'] }, r.hooks);
    assert.deepEqual(await fetcher.fetch('http://missing.example.test/'), { reachable: false, reason: 'dns_failed' });
  });

  it('an aborted signal ends the call at once (aborted), before any lookup', async () => {
    const r = resolver({ 'example.com': ['93.184.216.34'] });
    const tool = createFetchUrlToolWithHooks({ allowedHosts: ['example.com'] }, r.hooks);
    const controller = new AbortController();
    controller.abort(new Error('tool_timeout'));
    assert.equal(await code(tool.executor(request({ url: 'https://example.com/' }, ['example.com'], controller.signal))), 'aborted');
  });

  it('a hanging DNS lookup is cut by the abort signal', async () => {
    const hooks: FetchUrlHooks = { lookup: () => new Promise(() => undefined) };
    const tool = createFetchUrlToolWithHooks({ allowedHosts: ['example.com'] }, hooks);
    const controller = new AbortController();
    const pending = code(tool.executor(request({ url: 'https://example.com/' }, ['example.com'], controller.signal)));
    controller.abort(new Error('tool_timeout'));
    assert.equal(await pending, 'aborted');
  });

  it('exemptAddresses is exact-match only: exempting 127.0.0.1 does not open other private addresses', async () => {
    const r = resolver({ 'a.example.test': ['127.0.0.2'], 'b.example.test': ['10.0.0.1'], 'c.example.test': ['::1'] });
    const hooks: FetchUrlHooks = { ...r.hooks, exemptAddresses: ['127.0.0.1'] };
    const tool = createFetchUrlToolWithHooks({ allowedHosts: ['*.example.test'] }, hooks);
    for (const host of ['a', 'b', 'c']) assert.equal(await code(tool.executor(request({ url: `http://${host}.example.test/` }, ['*.example.test']))), 'address_not_allowed', host);
  });

  it('the error message carries the code and no query string or user data', async () => {
    const tool = createFetchUrlToolWithHooks({ allowedHosts: ['example.com'] }, resolver({}).hooks);
    try {
      await tool.executor(request({ url: 'https://evil.test/path?token=SECRETVALUE123' }, ['example.com']));
      assert.fail('expected a refusal');
    } catch (error) {
      assert.ok(error instanceof FetchUrlError);
      assert.match(error.message, /^host_not_allowed:/);
      assert.ok(!error.message.includes('SECRETVALUE123'));
    }
  });
});

describe('htmlToText', () => {
  it('drops tags, comments, scripts and styles; decodes common entities; collapses whitespace', () => {
    const page = '<html><head><title>T</title><style>p{color:red}</style><script>var a="<b>";</script></head><body><!-- hidden --><p>Hello&nbsp;&amp; <b>world</b></p>\n<p>a &lt; b &#65;&#x42;</p></body></html>';
    assert.equal(htmlToText(page), 'T Hello & world a < b AB');
  });

  it('keeps a bare "<" that does not start a tag, and survives unterminated constructs', () => {
    assert.equal(htmlToText('1 < 2 and 3 > 2'), '1 < 2 and 3 > 2');
    assert.equal(htmlToText('keep <script>never closed'), 'keep');
    assert.equal(htmlToText('keep <b never closed'), 'keep');
    assert.equal(htmlToText('keep <!-- never closed'), 'keep');
    assert.equal(htmlToText('&#0; &#xD800; &#99999999; &unknown;'), '&#0; &#xD800; &#99999999; &unknown;');
  });

  it('is linear: a page made of thousands of unclosed script/comment openers does not take quadratic time', () => {
    const hostile = '<script>'.repeat(60_000) + '<!--'.repeat(60_000) + '<a '.repeat(60_000);
    const started = Date.now();
    htmlToText(hostile);
    assert.ok(Date.now() - started < 2000, 'htmlToText must not backtrack on hostile input');
  });
});
