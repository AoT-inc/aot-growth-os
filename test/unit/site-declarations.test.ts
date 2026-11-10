// AoT 도구 세 곳의 선언 초안(config/site-declarations/*.json)이 실제 설정 검증기를 통과하고, 안전 규칙을 지키는지 확인한다.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseMcpSites } from '@aot/agent-runtime';

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

test('no secrets: only environment variable names; hub and server addresses are placeholders', () => {
  for (const file of FILES) {
    const { text } = load(file);
    assert.ok(!/(aotmcp_|Bearer\s|token [A-Za-z0-9]{12,}|password|secret)/i.test(text), file);
    assert.ok(!/https:\/\/(?!.*(example\.com|example\.net))/.test(text.replace(/"\$schema".*/, '')), `${file}: only placeholder hosts`);
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

test('web: branch and PR only, never main; pins match the real declaration hashes (npm run mcp-pin says open)', async (t) => {
  const web = load('aot-web.json');
  const [manifest] = parseMcpSites([web.raw]);
  assert.deepEqual(manifest!.tools.map((tool) => tool.name).sort(), ['create_post_branch', 'list_images', 'list_posts', 'open_post_pr']);
  const write = manifest!.tools.filter((tool) => tool.impact === 'external_effect');
  assert.equal(write.length, 2);
  for (const tool of write) {
    assert.equal(tool.api!.op.request.method, 'POST');
    assert.ok(/\/repos\/aot\/aot-web\/(contents|pulls)$/.test(tool.api!.op.request.path), tool.api!.op.request.path);
  }
  assert.ok(!/"branch":\s*\{\s*"\$const":\s*"(?!main)/.test(web.text));
  const configPath = join(makeTempDir(t), 'daemon.config.json');
  writeFileSync(configPath, JSON.stringify({ mcp_sites: [web.raw] }));
  const result = await runMcpPin([configPath, 'web'], { AOT_API_WEB_TOKEN: 'token placeholder' });
  assert.equal(result.code, 0, result.output);
  const statuses = result.output.split('\n').filter((line) => /^\S+ +"/.test(line)).map((line) => line.split(' ')[0]);
  assert.equal(statuses.length, 4);
  assert.ok(statuses.every((status) => status === 'open'), result.output);
});
