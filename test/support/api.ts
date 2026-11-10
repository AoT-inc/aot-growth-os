// API 전송 시험 공용 (ADR-0020): gitea 모양의 사이트 선언(읽기 2개 + 쓰기 1개), 선언 고정 채우기, 실제 커넥터 프로세스로 사이트 연결 시작.
import { createMcpSiteClient, apiPinOf, parseMcpSite, spawnConnectorProcess, type McpSiteClient, type McpSiteEvent, type McpSiteManifest } from '@aot/agent-runtime';
import type { Clock } from '@aot/domain';
import { systemClock } from '@aot/domain';
import type { TestContext } from 'node:test';

export const API_TOKEN_ENV = 'AOT_API_WEB_TOKEN';
/** 시험용 가짜 토큰 (실제 비밀이 아니다). gitea 의 `Authorization: token <값>` 형식 */
export const API_TOKEN = 'token tk-example-0123456789abcdef';
export const API_SECRET_ENV = { [API_TOKEN_ENV]: API_TOKEN } as const;

export const API_READ_TOOL = 'mcp_web_list_posts';
export const API_WRITE_TOOL = 'mcp_web_draft_post';
export const API_GET_TOOL = 'mcp_web_get_post';

const FRONT = (lang: 'ko' | 'en'): string =>
  `---\ntitle: {${lang}_title|json_string}\ndate: {date}\ncategory: "AoT blog"\nexcerpt: {${lang}_excerpt|json_string}\npublished: false\n---\n\n{${lang}_body}\n`;

export const listPostsDecl = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'list_posts', as: 'list_posts', description: '한국어 글 파일 이름 목록을 읽는다. 읽기 전용.', scope: 'internal', impact: 'read', side_effect: false, target: 'site:web/posts',
  args: {}, request: { method: 'GET', path: '/repos/aot/aot-web/contents/src/ko/posts', query: { ref: 'main' } }, returns: ['/*/name'], ...over,
});

/** 인자로 경로와 쿼리가 정해지는 읽기: 주입 시험용 */
export const getPostDecl = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'get_post', as: 'get_post', description: '글 파일 하나의 정보를 읽는다. 읽기 전용.', scope: 'internal', impact: 'read', side_effect: false, target: 'site:web/posts',
  args: {
    file: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,60}\\.md$', required: true },
    ref: { type: 'string', max_length: 100 },
  },
  request: { method: 'GET', path: '/repos/aot/aot-web/contents/src/ko/posts/{file}', query: { ref: { $arg: 'ref' } } },
  returns: ['/name', '/sha'], ...over,
});

export const draftPostDecl = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'create_post_branch', as: 'draft_post', description: '홈페이지 글 초안(한국어·영어 한 쌍)을 새 브랜치로 올린다. main 에는 닿지 않는다.',
  scope: 'public', impact: 'external_effect', side_effect: true, approval: 'draft', target: 'site:web/posts',
  args: {
    slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{2,60}$', required: true },
    date: { type: 'string', pattern: '^20[0-9]{2}-[01][0-9]-[0-3][0-9]$', required: true },
    ko_title: { type: 'string', max_length: 120, pattern: '^[^\\n\\r]+$', required: true },
    ko_excerpt: { type: 'string', max_length: 300, pattern: '^[^\\n\\r]+$', required: true },
    ko_body: { type: 'string', max_length: 20000, required: true },
    en_title: { type: 'string', max_length: 120, pattern: '^[^\\n\\r]+$', required: true },
    en_excerpt: { type: 'string', max_length: 300, pattern: '^[^\\n\\r]+$', required: true },
    en_body: { type: 'string', max_length: 20000, required: true },
  },
  request: {
    method: 'POST', path: '/repos/aot/aot-web/contents',
    body: {
      branch: { $const: 'main' },
      new_branch: { $template: 'agent/post-{slug}' },
      message: { $template: '글 초안 {slug}\n\neffect-key: {effect_key}' },
      files: [
        { operation: { $const: 'create' }, path: { $template: 'src/ko/posts/{slug}.md' }, content: { $template: FRONT('ko'), encode: 'base64' } },
        { operation: { $const: 'create' }, path: { $template: 'src/en/posts/{slug}.md' }, content: { $template: FRONT('en'), encode: 'base64' } },
      ],
    },
  },
  record: ['/commit/sha', '/commit/html_url'], ...over,
});

export const POST_ARGS = {
  slug: 'hello-farm', date: '2026-11-10',
  ko_title: '스마트팜 "첫" 글: 🌱', ko_excerpt: '요약', ko_body: '본문 한국어\n둘째 줄',
  en_title: 'Hello farm', en_excerpt: 'Summary', en_body: 'Body in English',
} as const;

export function apiSiteRaw(baseUrl: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    site: 'web', transport: { kind: 'api', base_url: baseUrl, network: 'loopback' },
    auth: { kind: 'header', header: 'Authorization', value_env: API_TOKEN_ENV },
    rate_limit_per_minute: 60, timeout_ms: 5000,
    tools: [listPostsDecl(), getPostDecl(), draftPostDecl()], ...over,
  };
}

/** 선언 고정을 mcp-pin 이 내는 값으로 채운다 (오너가 하는 일) */
export function withPins(raw: Record<string, unknown>): Record<string, unknown> {
  const manifest = parseMcpSite(raw);
  const tools = (raw['tools'] as Record<string, unknown>[]).map((tool) => {
    const decl = manifest.tools.find((entry) => entry.name === tool['name'])!;
    return { ...tool, pin: apiPinOf(decl) };
  });
  return { ...raw, tools };
}

export const pinnedManifest = (raw: Record<string, unknown>): McpSiteManifest => parseMcpSite(withPins(raw));

export interface ApiRig { client: McpSiteClient; manifest: McpSiteManifest; events: McpSiteEvent[] }

export async function startApiSite(t: TestContext, raw: Record<string, unknown>, options: { clock?: Clock; pinned?: boolean } = {}): Promise<ApiRig> {
  const manifest = options.pinned === false ? parseMcpSite(raw) : pinnedManifest(raw);
  const events: McpSiteEvent[] = [];
  const client = createMcpSiteClient({ manifest, clock: options.clock ?? systemClock, spawn: () => spawnConnectorProcess(API_SECRET_ENV), onEvent: (e) => events.push(e) });
  t.after(() => client.close());
  await client.start();
  return { client, manifest, events };
}

export const callOf = (rig: ApiRig, name: string, args: Record<string, unknown>) => rig.client.call(name, args, { timeoutMs: 8000 });
