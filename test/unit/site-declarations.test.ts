// AoT 도구 세 곳의 선언 초안(config/site-declarations/*.json)이 실제 설정 검증기를 통과하고, 안전 규칙을 지키는지 확인한다.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { ApiBuildError, buildApiRequest, parseMcpSites } from '@aot/agent-runtime';

import { runMcpPin } from '../../apps/daemon/src/mcp-pin.ts';
import { makeTempDir } from '../support/temp.ts';

const dir = join(import.meta.dirname, '../../config/site-declarations');
const load = (file: string): { raw: Record<string, unknown>; text: string } => {
  const text = readFileSync(join(dir, file), 'utf8');
  return { raw: JSON.parse(text) as Record<string, unknown>, text };
};
const FILES = ['aot-project.json', 'aot-course.json', 'aot-web.json'];

test('all three declarations pass the real validator and every write needs approval', () => {
  const manifests = parseMcpSites(FILES.map((file) => load(file).raw));
  assert.deepEqual(manifests.map((m) => m.site), ['project', 'course', 'web']);
  for (const manifest of manifests) {
    assert.ok(manifest.tools.length > 0);
    for (const tool of manifest.tools) {
      if (tool.impact === 'external_effect') assert.equal(tool.approval, 'draft', `${manifest.site}/${tool.name}`);
      else assert.equal(tool.approval, null);
    }
  }
});

test('no secrets: only environment variable names; every https host in a declaration is a placeholder host', () => {
  for (const file of FILES) {
    const { text } = load(file);
    assert.ok(!/(aotmcp_|Bearer\s|token [A-Za-z0-9]{12,}|password|secret)/i.test(text), file);
    for (const match of text.matchAll(/https?:\/\/([^/"\s:]+)/g)) {
      assert.match(match[1]!, /(^|\.)(example\.com|example\.net)$/, `${file}: ${match[0]}`);
    }
  }
});

test('project: reads plus draft-only writes; finance and external-fetch tools are not declared', () => {
  const [project] = parseMcpSites([load('aot-project.json').raw]);
  const names = project!.tools.map((tool) => tool.name);
  for (const forbidden of ['finance', 'shop_search', 'import_link']) assert.ok(!names.includes(forbidden), forbidden);
  assert.ok(names.includes('set_quote_draft_items'));
  assert.ok(project!.tools.every((tool) => tool.scope === 'internal'));
  assert.deepEqual(project!.auth.kind === 'oauth_delegated' ? project!.auth.scopes : [], ['project.read', 'project.write']);
});

test('course: destructive, people, invitation, classroom-write and video tools are not declared; pins are placeholders that keep the tools closed', () => {
  const [course] = parseMcpSites([load('aot-course.json').raw]);
  const names = course!.tools.map((tool) => tool.name);
  for (const forbidden of ['unit_delete', 'unit_restore', 'people_decide', 'people_remove', 'invitation_create', 'student_reset_link', 'classroom_delete', 'video_script_put', 'video_render', 'media_import']) assert.ok(!names.includes(forbidden), forbidden);
  assert.deepEqual(course!.auth.kind === 'oauth_delegated' ? course!.auth.scopes : [], ['course.read', 'units.write']);
  assert.ok(course!.tools.every((tool) => tool.inputSchemaSha256 === `sha256:${'0'.repeat(64)}`), 'run npm run mcp-pin and replace the placeholders');
  // 하나의 도구가 op 목록을 받아도 분류는 호출 단위다: unit_update 는 쓰기·초안 승인
  const update = course!.tools.find((tool) => tool.name === 'unit_update')!;
  assert.equal(update.impact, 'external_effect');
  assert.equal(update.approval, 'draft');
});

const WEB_ARGS = {
  slug: 'my-post', date: '2026-11-11', image: 'cover.webp', ko_title: '제목', ko_excerpt: '요약', ko_body: '본문입니다.', en_title: 'Title', en_excerpt: 'Excerpt', en_body: 'Body.', effect_key: 'eff-1',
};

test('web: only branch + PR writes with fixed shape; reads are GET on fixed paths; pins match the real hashes (mcp-pin says open)', async (t) => {
  const web = load('aot-web.json');
  const [manifest] = parseMcpSites([web.raw]);
  assert.deepEqual(manifest!.tools.map((tool) => tool.name).sort(), ['create_post_branch', 'list_images', 'list_posts', 'open_post_pr']);
  const byName = Object.fromEntries(manifest!.tools.map((tool) => [tool.name, tool]));
  // 쓰기: 새 브랜치는 비어 있지 않은 agent/post- 템플릿이고 기준은 main 상수, PR 의 head 도 같은 접두어, base 는 main
  const branch = byName['create_post_branch']!.api!.op.request;
  assert.equal(branch.method, 'POST');
  assert.equal(branch.path, '/repos/aot/aot-web/contents');
  const body = branch.body as Record<string, unknown>;
  assert.deepEqual(body['branch'], { $const: 'main' });
  assert.deepEqual(body['new_branch'], { $template: 'agent/post-{slug}' });
  const pr = byName['open_post_pr']!.api!.op.request;
  assert.equal(pr.method, 'POST');
  assert.equal(pr.path, '/repos/aot/aot-web/pulls');
  assert.deepEqual((pr.body as Record<string, unknown>)['head'], { $template: 'agent/post-{slug}' });
  assert.deepEqual((pr.body as Record<string, unknown>)['base'], { $const: 'main' });
  for (const name of ['list_images', 'list_posts']) {
    assert.equal(byName[name]!.api!.op.request.method, 'GET');
    assert.match(byName[name]!.api!.op.request.path, /^\/repos\/aot\/aot-web\/contents\/(static\/img|src\/ko\/posts)$/);
  }
  assert.equal(manifest!.tools.filter((tool) => tool.impact === 'external_effect').length, 2);
  // 실제 요청에서 새 브랜치는 slug 가 무엇이든 agent/post- 로 시작하고 main 이 될 수 없다
  const built = JSON.parse(buildApiRequest(byName['create_post_branch']!.api!.op, WEB_ARGS, '/api/v1').body!) as { branch: string; new_branch: string };
  assert.equal(built.branch, 'main');
  assert.equal(built.new_branch, 'agent/post-my-post');
  assert.throws(() => buildApiRequest(byName['create_post_branch']!.api!.op, { ...WEB_ARGS, slug: '' }, '/api/v1'), ApiBuildError);
  const configPath = join(makeTempDir(t), 'daemon.config.json');
  writeFileSync(configPath, JSON.stringify({ mcp_sites: [web.raw] }));
  const result = await runMcpPin([configPath, 'web'], { AOT_API_WEB_TOKEN: 'token placeholder' });
  assert.equal(result.code, 0, result.output);
  const statuses = result.output.split('\n').filter((line) => /^\S+ +"/.test(line)).map((line) => line.split(' ')[0]);
  assert.equal(statuses.length, 4);
  assert.ok(statuses.every((status) => status === 'open'), result.output);
});

test('web: hostile arguments are refused before any request is built', () => {
  const [manifest] = parseMcpSites([load('aot-web.json').raw]);
  const post = manifest!.tools.find((tool) => tool.name === 'create_post_branch')!.api!.op;
  const pr = manifest!.tools.find((tool) => tool.name === 'open_post_pr')!.api!.op;
  const build = (over: Record<string, unknown>, op = post) => buildApiRequest(op, { ...WEB_ARGS, ...over }, '/api/v1');
  build({}); // 정상 값은 통과한다
  const refused: [string, Record<string, unknown>][] = [
    ['slug with a slash', { slug: 'a/b' }], ['slug with dot-dot', { slug: 'a/../b' }], ['slug with newline', { slug: 'ab\ncd' }], ['slug too short', { slug: 'ab' }],
    ['title newline', { ko_title: '제목\n---\npublished: true' }], ['title NEL', { en_title: 'x\u0085y' }], ['image traversal', { image: '../x.webp' }], ['image path', { image: 'a/b.webp' }],
    ['undeclared branch', { branch: 'main' }], ['undeclared new_branch', { new_branch: 'main' }], ['calendar-impossible date', { date: '2026-02-31' }], ['month 13', { date: '2026-13-01' }],
    ['template braces in ko_body', { ko_body: '{{ x }}' }], ['njk tag in en_body', { en_body: '{% include "y" %}' }], ['comment tag', { ko_body: '{# x #}' }], ['lone brace', { en_body: 'a } b' }],
    ['NUL in body', { ko_body: 'a\u0000b' }], ['NUL in en body', { en_body: 'a\u0000b' }], ['body too long', { ko_body: 'a'.repeat(20001) }], ['en body too long', { en_body: 'a'.repeat(20001) }],
  ];
  for (const [label, over] of refused) assert.throws(() => build(over), ApiBuildError, label);
  build({ date: '2024-02-29' });
  build({ ko_body: '여러 줄\n\n본문 **굵게** [링크](https://example.com) 코드' });
  // 2048자를 넘는 긴 글은 이제 통과한다(패턴이 없어 2048 규칙에 묶이지 않는다). 상한은 20000자
  build({ ko_body: '가'.repeat(20000), en_body: 'a'.repeat(20000) });
  build({ ko_body: `${'본문 문장입니다. '.repeat(400)}\n\n**굵게** [링크](https://example.com)`.slice(0, 3000) });
  const longBody = JSON.parse(build({ ko_body: '가'.repeat(5000) }).body!) as { files: { content: string }[] };
  assert.ok(Buffer.from(longBody.files[0]!.content, 'base64').toString('utf8').includes('가'.repeat(5000)));
  // PR: head 는 slug 로만 정해지고 제목 줄바꿈·선언 밖 인자를 받지 않는다
  const prArgs = { slug: 'my-post', title: '제목', summary: '요약', effect_key: 'eff-1' };
  const head = (JSON.parse(buildApiRequest(pr, prArgs, '/api/v1').body!) as { head: string; base: string });
  assert.deepEqual([head.head, head.base], ['agent/post-my-post', 'main']);
  assert.throws(() => buildApiRequest(pr, { ...prArgs, slug: 'a/b' }, '/api/v1'), ApiBuildError);
  assert.throws(() => buildApiRequest(pr, { ...prArgs, title: 'a\nb' }, '/api/v1'), ApiBuildError);
  assert.throws(() => buildApiRequest(pr, { ...prArgs, base: 'dev' }, '/api/v1'), ApiBuildError);
});
