// 팩 로더 (A6-U10): 팩 파일 검증, {{자리표시자}} 치환, 템플릿 포트, 루틴의 멱등 DB 반영. 팩은 데이터라 코드 없이 디렉터리만 읽는다.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { validateTaskSpec, type Db } from '@aot/domain';
import { TaskCreationError } from '@aot/task-engine';

import { loadPack, PackLoadError, PackSyncError, packOptionsFromConfig, syncPackRoutines, type PackIssue, type PackOptions } from '../../apps/daemon/src/pack-loader.ts';
import { makeTempDir } from '../support/temp.ts';
import { REPO_ROOT } from '../support/schema-snapshot.ts';
import { seededDb, START } from '../support/seeded-db.ts';

const PACK_DIR = join(REPO_ROOT, 'packs', 'example-marketing');
const VALUES = {
  org_unit: 'core',
  product: 'example-product',
  research_source_url: 'https://docs.example.com/market-news',
  research_host: 'docs.example.com',
};
const SLOT = '2026-10-26T00:00:00.000Z'; // Monday 09:00 Asia/Seoul

const issuesOf = (options: PackOptions): readonly PackIssue[] => {
  try {
    loadPack(options);
  } catch (error) {
    assert.ok(error instanceof PackLoadError, String(error));
    return error.issues;
  }
  assert.fail('expected the pack to be rejected');
};
const has = (issues: readonly PackIssue[], file: string, code: string, path?: string): boolean =>
  issues.some((i) => i.file === file && i.code === code && (path === undefined || i.path === path));

/** 예제 팩의 복사본. 시험이 파일을 바꿔 본다 */
function copyPack(t: TestContext): string {
  const dir = join(makeTempDir(t), 'pack');
  cpSync(PACK_DIR, dir, { recursive: true });
  return dir;
}
const readJson = (dir: string, file: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
const writeJson = (dir: string, file: string, value: unknown): void => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(value, null, 2));
};

function addProduct(db: Db, slug = 'example-product', status = 'registered'): void {
  db.writeTx((tx) => tx.run(
    "INSERT INTO product (id, slug, name, kind, lifecycle_stage, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'software', 'live', ?, ?, ?)",
    [`product-${slug}`, slug, slug, status, START, START],
  ));
}
const routineRows = (db: Db) => db.all('SELECT * FROM routine ORDER BY slug');

describe('the example pack', () => {
  it('passes whole-pack validation with the example values', () => {
    const pack = loadPack({ dir: PACK_DIR, values: VALUES });
    assert.equal(pack.manifest.name, 'example-marketing');
    assert.deepEqual(pack.routines.map((r) => [r.slug, r.schedule, r.catchUp, r.taskTemplate, r.orgUnit, r.product]), [
      ['weekly-market-research', '0 9 * * 1 Asia/Seoul', 'skip', 'weekly-market-research@1', 'core', 'example-product'],
    ]);
    assert.deepEqual(pack.templates.map((t) => [t.id, t.version, t.tasks.map((task) => task.name)]), [['weekly-market-research', 1, ['research']]]);
    assert.deepEqual(pack.signals.map((s) => [s.id, s.page_ref, s.period, s.tz, s.min_observations, s.attachment_required]), [
      ['weekly-landing-conversions', 'landing:example-product', 'iso_week', 'Asia/Seoul', 1, true],
    ]);
  });

  it('holds no real value: every instance value is a placeholder, the files carry no secret-looking text', () => {
    const files = ['manifest.json', 'routines/weekly-market-research.json', 'workflows/weekly-market-research.json', 'measurement-signals/weekly-landing-conversions.json'];
    for (const file of files) {
      const text = readFileSync(join(PACK_DIR, file), 'utf8');
      assert.doesNotMatch(text, /\/Users\/|api[_-]?key|secret|token|password/i, file);
      for (const url of text.match(/https?:\/\/[^\s"]+/g) ?? []) assert.match(url, /\.example\.com\b/, `${file}: ${url}`);
    }
    // 템플릿의 출처 주소·호스트·제품은 자리표시자다
    const spec = JSON.stringify(readJson(PACK_DIR, 'workflows/weekly-market-research.json'));
    for (const name of ['product', 'research_source_url', 'research_host']) assert.ok(spec.includes(`{{${name}}}`), name);
  });

  it('the template source returns tasks whose specs pass validateTaskSpec after substitution', () => {
    const pack = loadPack({ dir: PACK_DIR, values: VALUES });
    const routine = { id: 'r1', slug: 'weekly-market-research', orgUnitId: 'u', productId: null, schedule: '0 9 * * 1 Asia/Seoul', taskTemplate: 'weekly-market-research@1', catchUp: 'skip' as const };
    const tasks = pack.templateSource.resolve({ routine, scheduledFor: SLOT });
    assert.equal(tasks.length, 1);
    const [task] = tasks;
    assert.equal(task?.name, 'research');
    const spec = task!.spec;
    assert.equal(validateTaskSpec(spec, 'draft').ok, true);
    assert.equal(spec['product'], 'example-product');
    assert.equal(spec['objective'], 'example-product 관련 시장의 지난 7일 주요 변화를 출처와 함께 정리한다');
    assert.deepEqual(spec['inputs'], [
      { name: 'keywords', ref: 'strategy:active#research_keywords', kind: 'strategy' },
      { name: 'market-news', ref: 'https://docs.example.com/market-news', kind: 'source_url' },
    ]);
    assert.deepEqual((spec['constraints'] as Record<string, unknown>)['network_allowlist'], ['docs.example.com']);
    assert.deepEqual(spec['trigger'], { kind: 'routine', ref: `weekly-market-research@${SLOT}` });
    assert.ok(!JSON.stringify(spec).includes('{{'), 'no placeholder survives');
  });

  it('each call returns a fresh copy (a consumer cannot change the loaded template)', () => {
    const pack = loadPack({ dir: PACK_DIR, values: VALUES });
    const routine = { id: 'r1', slug: 'weekly-market-research', orgUnitId: 'u', productId: null, schedule: 's', taskTemplate: 'weekly-market-research@1', catchUp: 'skip' as const };
    const first = pack.templateSource.resolve({ routine, scheduledFor: SLOT });
    first[0]!.spec['objective'] = 'tampered';
    (first[0]!.spec['inputs'] as unknown[]).length = 0;
    const second = pack.templateSource.resolve({ routine, scheduledFor: SLOT });
    assert.notEqual(second[0]!.spec['objective'], 'tampered');
    assert.equal((second[0]!.spec['inputs'] as unknown[]).length, 2);
  });

  it('an unknown template is an error (and not a deterministic task rejection)', () => {
    const pack = loadPack({ dir: PACK_DIR, values: VALUES });
    const routine = { id: 'r1', slug: 'x', orgUnitId: 'u', productId: null, schedule: 's', taskTemplate: 'other@1', catchUp: 'skip' as const };
    assert.throws(() => pack.templateSource.resolve({ routine, scheduledFor: SLOT }), (error: unknown) => error instanceof Error && !(error instanceof TaskCreationError) && /other@1/.test(error.message));
  });
});

describe('placeholders', () => {
  it('an unfilled placeholder is rejected when the pack is loaded, naming the placeholder and where it is', () => {
    const missing: Record<string, string> = { ...VALUES };
    delete missing['research_host'];
    const issues = issuesOf({ dir: PACK_DIR, values: missing });
    assert.ok(has(issues, 'workflows/weekly-market-research.json', 'unresolved_placeholder', 'tasks[0].spec.constraints.network_allowlist[0]'));
    assert.ok(issues.some((i) => i.message.includes('{{research_host}}')));
    assert.ok(!issues.some((i) => i.code === 'unresolved_placeholder' && i.message.includes('{{product}}')), 'only the missing one is reported');
    assert.ok(has(issuesOf({ dir: PACK_DIR }), 'routines/weekly-market-research.json', 'unresolved_placeholder', 'org_unit'), 'with no values at all, the routine declaration is checked too');
  });

  it('a substituted value that makes the spec invalid is rejected by validateTaskSpec', () => {
    const issues = issuesOf({ dir: PACK_DIR, values: { ...VALUES, research_host: '*' } });
    assert.ok(has(issues, 'workflows/weekly-market-research.json', 'wildcard', 'tasks[0].spec.constraints.network_allowlist[0]'));
  });

  it('values are checked: bad names, blank values, braces (a value cannot smuggle in another placeholder)', () => {
    assert.ok(has(issuesOf({ dir: PACK_DIR, values: { ...VALUES, 'Bad-Name': 'x' } }), 'pack_values', 'name'));
    assert.ok(has(issuesOf({ dir: PACK_DIR, values: { ...VALUES, product: ' ' } }), 'pack_values', 'type'));
    assert.ok(has(issuesOf({ dir: PACK_DIR, values: { ...VALUES, product: '{{research_host}}' } }), 'pack_values', 'braces'));
    assert.ok(has(issuesOf({ dir: PACK_DIR, values: { ...VALUES, product: 'a}}b' } }), 'pack_values', 'braces'));
  });

  it('a malformed placeholder or one in a key is rejected', (t) => {
    const dir = copyPack(t);
    const template = readJson(dir, 'workflows/weekly-market-research.json');
    const spec = (template['tasks'] as { spec: Record<string, unknown> }[])[0]!.spec;
    spec['objective'] = '{{Product}} stray }} text';
    writeJson(dir, 'workflows/weekly-market-research.json', template);
    assert.ok(has(issuesOf({ dir, values: VALUES }), 'workflows/weekly-market-research.json', 'malformed_placeholder', 'tasks[0].spec.objective'));

    spec['objective'] = 'fine';
    spec['{{product}}'] = 'x';
    writeJson(dir, 'workflows/weekly-market-research.json', template);
    assert.ok(has(issuesOf({ dir, values: VALUES }), 'workflows/weekly-market-research.json', 'placeholder_in_key'));
  });

  it('a value with quotes stays inside its string', (t) => {
    const dir = copyPack(t);
    const pack = loadPack({ dir, values: { ...VALUES, research_source_url: 'https://docs.example.com/a"b,"c":{"d":1}' } });
    const routine = { id: 'r1', slug: 'weekly-market-research', orgUnitId: 'u', productId: null, schedule: 's', taskTemplate: 'weekly-market-research@1', catchUp: 'skip' as const };
    const [task] = pack.templateSource.resolve({ routine, scheduledFor: SLOT });
    const inputs = task!.spec['inputs'] as { ref: string }[];
    assert.equal(inputs.length, 2);
    assert.equal(inputs[1]!.ref, 'https://docs.example.com/a"b,"c":{"d":1}');
  });
});

describe('pack file validation', () => {
  const mutate = (t: TestContext, file: string, change: (json: Record<string, unknown>) => void): string => {
    const dir = copyPack(t);
    const json = readJson(dir, file);
    change(json);
    writeJson(dir, file, json);
    return dir;
  };

  it('manifest problems are reported with their file', (t) => {
    const dir = mutate(t, 'manifest.json', (m) => { m['name'] = 'Bad Name'; });
    assert.ok(has(issuesOf({ dir, values: VALUES }), 'manifest.json', 'format', 'name'));
    assert.ok(has(issuesOf({ dir: join(dir, 'nowhere'), values: VALUES }), 'manifest.json', 'missing'));
  });

  it('a routine with a bad schedule, unknown key, missing catch_up or unknown template is rejected', (t) => {
    const file = 'routines/weekly-market-research.json';
    assert.ok(has(issuesOf({ dir: mutate(t, file, (r) => { r['schedule'] = '0 9 * * 1'; }), values: VALUES }), file, 'schedule', 'schedule'), 'no time zone');
    assert.ok(has(issuesOf({ dir: mutate(t, file, (r) => { r['enabled'] = 1; }), values: VALUES }), file, 'unknown_field', 'enabled'), 'a pack cannot switch a routine on');
    assert.ok(has(issuesOf({ dir: mutate(t, file, (r) => { delete r['catch_up']; }), values: VALUES }), file, 'enum', 'catch_up'));
    assert.ok(has(issuesOf({ dir: mutate(t, file, (r) => { r['catch_up'] = 'always'; }), values: VALUES }), file, 'enum', 'catch_up'));
    assert.ok(has(issuesOf({ dir: mutate(t, file, (r) => { r['task_template'] = 'missing@1'; }), values: VALUES }), file, 'unknown_template'));
    assert.ok(has(issuesOf({ dir: mutate(t, file, (r) => { r['task_template'] = 'weekly-market-research'; }), values: VALUES }), file, 'format', 'task_template'));
  });

  it('a template that sets trigger/dependencies, has duplicate or cyclic tasks, or an invalid spec is rejected', (t) => {
    const file = 'workflows/weekly-market-research.json';
    const task = (json: Record<string, unknown>) => (json['tasks'] as Record<string, unknown>[])[0]!;
    const specOf = (json: Record<string, unknown>) => task(json)['spec'] as Record<string, unknown>;
    assert.ok(has(issuesOf({ dir: mutate(t, file, (j) => { specOf(j)['trigger'] = { kind: 'manual', ref: 'x' }; }), values: VALUES }), file, 'engine_field'));
    assert.ok(has(issuesOf({ dir: mutate(t, file, (j) => { specOf(j)['dependencies'] = ['task-1']; }), values: VALUES }), file, 'engine_field'));
    assert.ok(has(issuesOf({ dir: mutate(t, file, (j) => { (j['tasks'] as unknown[]).push({ ...task(j) }); }), values: VALUES }), file, 'duplicate'));
    assert.ok(has(issuesOf({ dir: mutate(t, file, (j) => { task(j)['depends_on'] = ['research']; }), values: VALUES }), file, 'cycle'));
    assert.ok(has(issuesOf({ dir: mutate(t, file, (j) => { task(j)['depends_on'] = ['ghost']; }), values: VALUES }), file, 'not_found'));
    assert.ok(has(issuesOf({ dir: mutate(t, file, (j) => { delete specOf(j)['acceptance_criteria']; }), values: VALUES }), file, 'required', 'tasks[0].spec.acceptance_criteria'));
    assert.ok(has(issuesOf({ dir: mutate(t, file, (j) => { specOf(j)['policy_version'] = 'v1'; }), values: VALUES }), file, 'system_field'));
    assert.ok(has(issuesOf({ dir: mutate(t, file, (j) => { j['tasks'] = []; }), values: VALUES }), file, 'required', 'tasks'));
  });

  it('a template with two ordered tasks is accepted and keeps the dependency names', (t) => {
    const file = 'workflows/weekly-market-research.json';
    const dir = mutate(t, file, (j) => {
      const first = (j['tasks'] as Record<string, unknown>[])[0]!;
      (j['tasks'] as unknown[]).push({ name: 'summarize', depends_on: ['research'], spec: structuredClone(first['spec']) });
    });
    const pack = loadPack({ dir, values: VALUES });
    const routine = { id: 'r1', slug: 'weekly-market-research', orgUnitId: 'u', productId: null, schedule: 's', taskTemplate: 'weekly-market-research@1', catchUp: 'skip' as const };
    const tasks = pack.templateSource.resolve({ routine, scheduledFor: SLOT });
    assert.deepEqual(tasks.map((task) => [task.name, task.dependsOn]), [['research', []], ['summarize', ['research']]]);
  });

  it('a measurement signal that breaks the format is rejected with its file', (t) => {
    const file = 'measurement-signals/weekly-landing-conversions.json';
    assert.ok(has(issuesOf({ dir: mutate(t, file, (s) => { s['attachment_required'] = false; }), values: VALUES }), file, 'must_be_true'));
    assert.ok(has(issuesOf({ dir: mutate(t, file, (s) => { s['page_ref'] = 'https://shop.example.com/'; }), values: VALUES }), file, 'url_not_allowed'));
  });

  it('file names must match the identity inside, and a declared directory must exist', (t) => {
    const dir = copyPack(t);
    writeJson(dir, 'measurement-signals/other-name.json', { ...readJson(dir, 'measurement-signals/weekly-landing-conversions.json') });
    assert.ok(has(issuesOf({ dir, values: VALUES }), 'measurement-signals/other-name.json', 'file_name', 'id'));
    const dir2 = mutate(t, 'manifest.json', (m) => { (m['contents'] as Record<string, string>)['routines'] = 'nope/'; });
    assert.ok(has(issuesOf({ dir: dir2, values: VALUES }), 'manifest.json', 'missing_dir', 'contents.routines'));
  });

  it('invalid JSON and symbolic links are rejected, other files are ignored', (t) => {
    const dir = copyPack(t);
    writeFileSync(join(dir, 'routines', 'broken.json'), '{ not json');
    writeFileSync(join(dir, 'routines', 'notes.txt'), 'ignored');
    symlinkSync(join(dir, 'routines', 'weekly-market-research.json'), join(dir, 'routines', 'linked.json'));
    const issues = issuesOf({ dir, values: VALUES });
    assert.ok(has(issues, 'routines/broken.json', 'json'));
    assert.ok(has(issues, 'routines/linked.json', 'not_a_file'));
    assert.ok(!issues.some((i) => i.file.endsWith('notes.txt')));
  });

  it('collects every problem instead of stopping at the first', (t) => {
    const dir = mutate(t, 'routines/weekly-market-research.json', (r) => { r['schedule'] = 'nonsense'; r['catch_up'] = 'x'; });
    const issues = issuesOf({ dir, values: {} });
    assert.ok(issues.length >= 4, `got ${issues.length}`);
    assert.ok(issues.every((i) => i.file !== '' && i.message !== ''));
  });
});

describe('syncPackRoutines: routines reach the database disabled, and idempotently', () => {
  it('creates the routine with enabled=0 and links the org unit and product by slug', (t) => {
    const { db } = seededDb(t);
    addProduct(db);
    const pack = loadPack({ dir: PACK_DIR, values: VALUES });
    assert.deepEqual(syncPackRoutines(db, pack), { created: ['weekly-market-research'], updated: [], unchanged: [] });
    const [row] = routineRows(db);
    assert.deepEqual({ ...row }, {
      id: 'routine-weekly-market-research', slug: 'weekly-market-research', org_unit_id: 'org-unit-core', schedule: '0 9 * * 1 Asia/Seoul',
      task_template: 'weekly-market-research@1', catch_up: 'skip', enabled: 0, product_id: 'product-example-product',
    });
  });

  it('running the loader twice leaves the database exactly as it was', (t) => {
    const { db } = seededDb(t);
    addProduct(db);
    const pack = loadPack({ dir: PACK_DIR, values: VALUES });
    syncPackRoutines(db, pack);
    const snapshot = JSON.stringify(routineRows(db));
    assert.deepEqual(syncPackRoutines(db, loadPack({ dir: PACK_DIR, values: VALUES })), { created: [], updated: [], unchanged: ['weekly-market-research'] });
    assert.equal(JSON.stringify(routineRows(db)), snapshot);
    assert.equal(db.get('SELECT count(*) AS n FROM routine_firing')?.['n'], 0);
    assert.equal(db.get('SELECT count(*) AS n FROM task')?.['n'], 0, 'loading never creates tasks');
  });

  it('a routine someone enabled stays enabled when the pack still matches (the loader never switches it back)', (t) => {
    const { db } = seededDb(t);
    addProduct(db);
    const pack = loadPack({ dir: PACK_DIR, values: VALUES });
    syncPackRoutines(db, pack);
    db.writeTx((tx) => tx.run("UPDATE routine SET enabled = 1 WHERE slug = 'weekly-market-research'"));
    assert.deepEqual(syncPackRoutines(db, pack).unchanged, ['weekly-market-research']);
    assert.equal(routineRows(db)[0]?.['enabled'], 1);
  });

  it('a changed pack updates a routine that is still disabled', (t) => {
    const { db } = seededDb(t);
    addProduct(db);
    syncPackRoutines(db, loadPack({ dir: PACK_DIR, values: VALUES }));
    const dir = copyPack(t);
    const file = 'routines/weekly-market-research.json';
    writeJson(dir, file, { ...readJson(dir, file), schedule: '30 8 * * 2 Asia/Seoul', catch_up: 'run_once' });
    assert.deepEqual(syncPackRoutines(db, loadPack({ dir, values: VALUES })), { created: [], updated: ['weekly-market-research'], unchanged: [] });
    assert.deepEqual([routineRows(db)[0]?.['schedule'], routineRows(db)[0]?.['catch_up'], routineRows(db)[0]?.['enabled']], ['30 8 * * 2 Asia/Seoul', 'run_once', 0]);
  });

  it('a changed pack is refused for an enabled routine and nothing is written (no pack edit can bypass the approval of an active routine)', (t) => {
    const { db } = seededDb(t);
    addProduct(db);
    syncPackRoutines(db, loadPack({ dir: PACK_DIR, values: VALUES }));
    db.writeTx((tx) => tx.run("UPDATE routine SET enabled = 1 WHERE slug = 'weekly-market-research'"));
    const before = JSON.stringify(routineRows(db));
    const dir = copyPack(t);
    const file = 'routines/weekly-market-research.json';
    writeJson(dir, file, { ...readJson(dir, file), schedule: '0 3 * * * UTC' });
    assert.throws(() => syncPackRoutines(db, loadPack({ dir, values: VALUES })), (error: unknown) =>
      error instanceof PackSyncError && error.code === 'routine_enabled_conflict' && /schedule/.test(error.message));
    assert.equal(JSON.stringify(routineRows(db)), before);
  });

  it('an unknown org unit, an unknown product or one that is not registered is refused and nothing is written', (t) => {
    const { db } = seededDb(t);
    const pack = loadPack({ dir: PACK_DIR, values: VALUES });
    assert.throws(() => syncPackRoutines(db, pack), (error: unknown) => error instanceof PackSyncError && error.code === 'unknown_product');
    assert.equal(routineRows(db).length, 0);
    addProduct(db, 'example-product', 'candidate');
    assert.throws(() => syncPackRoutines(db, pack), (error: unknown) => error instanceof PackSyncError && error.code === 'product_not_registered');
    assert.equal(routineRows(db).length, 0, 'a product that is not registered cannot be referenced');
    db.writeTx((tx) => tx.run("UPDATE product SET registration_status = 'registered'"));
    assert.throws(() => syncPackRoutines(db, loadPack({ dir: PACK_DIR, values: { ...VALUES, org_unit: 'nowhere' } })), (error: unknown) => error instanceof PackSyncError && error.code === 'unknown_org_unit');
    assert.equal(routineRows(db).length, 0);
  });

  it('a routine the pack no longer declares is left alone (never deleted, never switched off)', (t) => {
    const { db } = seededDb(t);
    addProduct(db);
    syncPackRoutines(db, loadPack({ dir: PACK_DIR, values: VALUES }));
    db.writeTx((tx) => tx.run("UPDATE routine SET enabled = 1 WHERE slug = 'weekly-market-research'"));
    const before = JSON.stringify(routineRows(db));
    const dir = copyPack(t);
    const manifest = readJson(dir, 'manifest.json');
    delete (manifest['contents'] as Record<string, string>)['routines'];
    writeJson(dir, 'manifest.json', manifest);
    assert.deepEqual(syncPackRoutines(db, loadPack({ dir, values: VALUES })), { created: [], updated: [], unchanged: [] });
    assert.equal(JSON.stringify(routineRows(db)), before);
  });
});

describe('packOptionsFromConfig', () => {
  it('no pack_dir means no pack (the previous behaviour); pack_values alone is a configuration error', () => {
    for (const config of [{}, { pack_dir: null }, { pack_dir: null, pack_values: null }]) assert.equal(packOptionsFromConfig(config), undefined);
    assert.throws(() => packOptionsFromConfig({ pack_values: { product: 'x' } }), /pack_dir/);
    assert.throws(() => packOptionsFromConfig({ pack_dir: ' ' }), /pack_dir/);
  });

  it('passes the directory and values through', () => {
    assert.deepEqual(packOptionsFromConfig({ pack_dir: 'packs/p', pack_values: { a: 'b' } }), { dir: 'packs/p', values: { a: 'b' } });
    assert.deepEqual(packOptionsFromConfig({ pack_dir: 'packs/p' }), { dir: 'packs/p' });
  });
});
