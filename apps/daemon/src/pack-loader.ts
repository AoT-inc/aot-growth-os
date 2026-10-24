// 도메인 팩 로더 (A6-U10, ADR-0012). 팩 디렉터리(`packs/<name>/`)를 *데이터*로 읽는다 — 팩의 코드를 import 하지 않는다(경계 lint `core-not-to-packs`).
//
// 읽는 것 (manifest.json 의 `contents` 가 가리키는 디렉터리의 `*.json`):
//   workflows/            업무 템플릿 `<id>.json`   { id, version, description?, tasks: [{ name, depends_on?, spec }] }   (spec = task-spec 초안, trigger·dependencies 금지)
//   routines/             루틴 선언 `<slug>.json`   { slug, description?, schedule, catch_up, task_template: "<id>@<version>", org_unit, product? }
//   measurement_signals/  측정 신호 `<id>.json`     validateMeasurementSignal 의 형식 (D2)
//   evaluations/, policy_examples/ 는 읽지 않는다(아직 내용이 없다). 팩은 정책·스키마·검증기를 바꿀 수 없다(ADR-0012 §3).
//
// 인스턴스 값 치환: 템플릿·루틴 선언의 *문자열 값* 안 `{{name}}`(소문자·숫자·밑줄)을 데몬 설정의 `pack_values` 로 바꾼다(JSON 구조를 만든 뒤 값만 바꾸므로 주입이 구조를 못 바꾼다).
//   치환은 단일 패스다. 값 안의 `{{`·`}}` 는 거부한다. 값이 없는 자리표시자, 모양이 틀린 `{{`·`}}` 는 거부한다. 치환한 업무 명세는 `validateTaskSpec` 을 통과해야 한다.
//   로드는 시작할 때 한 번 하고 *전부* 검증한다(필요한 값이 빠진 팩은 데몬이 시작하지 못한다). 템플릿을 해석할 때(`resolve`)도 trigger 를 붙여 다시 검증한다.
//
// DB 반영(`syncPackRoutines`): 한 트랜잭션, 멱등. 루틴은 항상 `enabled=0` 으로 만든다 — 켜는 것은 실험 승인(U15)의 몫이라 팩이 스스로 켤 수 없다.
//   - 없으면 만든다(`enabled=0`). 같으면 아무것도 하지 않는다(`enabled` 도 건드리지 않는다).
//   - 선언이 DB 행과 다르면: `enabled=0` 인 행은 선언에 맞춰 갱신한다(아직 승인된 적 없는 상태라 우회할 승인이 없다). `enabled=1` 인 행은 거부한다
//     (켜진 루틴의 일정·템플릿을 팩 파일 수정으로 바꾸면 승인 경로를 우회한다). 팩에서 사라진 루틴은 DB 에서 지우지도 끄지도 않는다.
//   - `org_unit`·`product` 는 slug 로 DB 행을 찾는다. 없거나(product 는 `registered` 여야 한다) 하면 거부하고 아무것도 쓰지 않는다.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  isNonBlankString, isPlainObject, TASK_RESULT_INPUT_KIND, TASK_RESULT_REF_PREFIX, validateMeasurementSignal, validatePackManifest, validateTaskSpec,
  type CatchUpMode, type Db, type Issue, type MeasurementSignal, type PackContentKey, type PackManifest, type PlainObject,
} from '@aot/domain';
import { parseSchedule, ScheduleError, TaskCreationError, type RoutineTemplateRequest, type RoutineTemplateSource, type RoutineTemplateTask } from '@aot/task-engine';

/** 팩 파일 하나의 문제. `file` 은 팩 디렉터리 기준 상대 경로(`manifest.json`, `workflows/x.json`, 설정이면 `pack_values`) */
export interface PackIssue extends Issue {
  file: string;
}

export class PackLoadError extends Error {
  readonly issues: readonly PackIssue[];
  constructor(issues: readonly PackIssue[]) {
    super(`pack rejected: ${issues.map((i) => `${i.file}${i.path === '' ? '' : `#${i.path}`}: ${i.message}`).join('; ')}`);
    this.name = 'PackLoadError';
    this.issues = issues;
  }
}

/** 팩 루틴을 DB 에 반영할 수 없을 때 (켜진 루틴과의 충돌, 없는 부서·제품). 아무것도 쓰지 않았다 */
export class PackSyncError extends Error {
  readonly code: 'routine_enabled_conflict' | 'unknown_org_unit' | 'unknown_product' | 'product_not_registered';
  readonly slug: string;
  constructor(code: PackSyncError['code'], slug: string, message: string) {
    super(`pack routine '${slug}': ${message}`);
    this.name = 'PackSyncError';
    this.code = code;
    this.slug = slug;
  }
}

export interface PackOptions {
  /** 팩 디렉터리 (manifest.json 이 있는 곳) */
  dir: string;
  /** 자리표시자 치환 값 (`{{name}}` → 값). 인스턴스 값이라 저장소에 두지 않는다 */
  values?: Readonly<Record<string, string>>;
}

/** 데몬 설정의 팩 키 (config/daemon.config.example.json) */
export interface PackConfig {
  pack_dir?: string | null;
  pack_values?: Record<string, string> | null;
}

/** 설정 → 팩 옵션. `pack_dir` 가 없으면 undefined(팩을 쓰지 않는다 = 이전 동작). `pack_values` 만 있으면 설정 오류다 */
export function packOptionsFromConfig(config: PackConfig): PackOptions | undefined {
  const dir = config.pack_dir ?? undefined;
  const values = config.pack_values ?? undefined;
  if (dir === undefined) {
    if (values !== undefined) throw new Error('pack_values needs pack_dir (the pack whose {{placeholders}} they fill)');
    return undefined;
  }
  if (!isNonBlankString(dir)) throw new Error('pack_dir must be a non-empty path');
  return { dir, ...(values === undefined ? {} : { values }) };
}

export interface PackRoutine {
  slug: string;
  description: string | null;
  schedule: string;
  catchUp: CatchUpMode;
  /** `<템플릿 id>@<version>` */
  taskTemplate: string;
  /** org_unit.slug (치환 뒤) */
  orgUnit: string;
  /** product.slug (치환 뒤). 선언에 없으면 null */
  product: string | null;
}

export interface PackTemplateTask {
  name: string;
  dependsOn: string[];
  /** 치환이 끝난 업무 명세 초안 (trigger 없음) */
  spec: PlainObject;
}

export interface PackTemplate {
  id: string;
  version: number;
  description: string | null;
  tasks: PackTemplateTask[];
}

/** 포트 구현. 동기라서 반환형을 좁혀 둔다(포트 `RoutineTemplateSource` 에 그대로 연결된다) */
export interface PackTemplateSource extends RoutineTemplateSource {
  resolve(request: RoutineTemplateRequest): readonly RoutineTemplateTask[];
}

export interface LoadedPack {
  dir: string;
  manifest: PackManifest;
  routines: PackRoutine[];
  templates: PackTemplate[];
  /** 측정 신호 정의 (D2). 값 입력·판정은 U13 이후 */
  signals: MeasurementSignal[];
  /** U9 의 템플릿 포트 구현. `TaskWorker` 의 `routines.source` 에 연결한다 */
  templateSource: PackTemplateSource;
}

const MAX_FILE_BYTES = 1024 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const TEMPLATE_REF = /^([a-z0-9][a-z0-9-]*)@([1-9][0-9]*)$/;
const VALUE_NAME = /^[a-z][a-z0-9_]*$/;
const PLACEHOLDER = /\{\{([a-z][a-z0-9_]*)\}\}/g;
const ROUTINE_KEYS = ['slug', 'description', 'schedule', 'catch_up', 'task_template', 'org_unit', 'product'];
const TEMPLATE_KEYS = ['id', 'version', 'description', 'tasks'];
const TASK_KEYS = ['name', 'depends_on', 'spec'];
/** 엔진이 정하는 필드. 템플릿이 넣으면 무시되거나 혼란을 낳으므로 거부한다 */
const ENGINE_OWNED_SPEC_FIELDS = ['trigger', 'dependencies'];

type Collect = ((file: string, path: string, code: string, message: string) => void) & { readonly count: number };

/** 팩을 읽고 전부 검증한다. 문제가 하나라도 있으면 PackLoadError(모든 문제 포함) */
export function loadPack(options: PackOptions): LoadedPack {
  const issues: PackIssue[] = [];
  const add: Collect = Object.assign(
    (file: string, path: string, code: string, message: string): void => void issues.push({ file, path, code, message }),
    { get count(): number { return issues.length; } },
  );
  const dir = resolve(options.dir);
  const values = checkValues(options.values ?? {}, add);

  const manifestRead = readJson(dir, 'manifest.json', add);
  if (manifestRead === undefined) throw new PackLoadError(issues);
  const manifestResult = validatePackManifest(manifestRead);
  if (!manifestResult.ok) {
    for (const e of manifestResult.errors) add('manifest.json', e.path, e.code, e.message);
    throw new PackLoadError(issues);
  }
  const manifest = manifestResult.value;

  const templates = readDeclarations(dir, manifest, 'workflows', 'id', add).flatMap(({ file, data }) => loadTemplate(file, data, values, add) ?? []);
  const routines = readDeclarations(dir, manifest, 'routines', 'slug', add).flatMap(({ file, data }) => loadRoutine(file, data, values, add) ?? []);
  const signals = readDeclarations(dir, manifest, 'measurement_signals', 'id', add).flatMap(({ file, data }) => {
    const result = validateMeasurementSignal(data);
    if (result.ok) return [result.value];
    for (const e of result.errors) add(file, e.path, e.code, e.message);
    return [];
  });

  const byRef = new Map(templates.map((template) => [`${template.id}@${template.version}`, template]));
  for (const routine of routines) {
    if (!byRef.has(routine.taskTemplate)) {
      add(`routines/${routine.slug}.json`, 'task_template', 'unknown_template', `task_template '${routine.taskTemplate}' is not a template of this pack (have: ${[...byRef.keys()].join(', ') || 'none'})`);
    }
  }
  // 모든 템플릿을 시작할 때 한 번 풀어 본다 — 치환 결과가 validateTaskSpec 을 통과하는지, 값이 빠지지 않았는지.
  for (const template of templates) {
    for (const issue of probeTemplate(template)) add(`workflows/${template.id}.json`, issue.path, issue.code, issue.message);
  }
  if (issues.length > 0) throw new PackLoadError(issues);

  return { dir, manifest, routines, templates, signals, templateSource: createTemplateSource(byRef) };
}

function checkValues(values: Readonly<Record<string, string>>, add: Collect): Record<string, string> {
  if (!isPlainObject(values)) {
    add('pack_values', '', 'type', 'pack_values must be an object of name -> string');
    return {};
  }
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (!VALUE_NAME.test(name)) add('pack_values', name, 'name', `placeholder name '${name}' must be lowercase letters, digits and underscores, starting with a letter`);
    else if (typeof value !== 'string' || value.trim() === '') add('pack_values', name, 'type', `value of '${name}' must be a non-empty string`);
    else if (value.includes('{{') || value.includes('}}')) add('pack_values', name, 'braces', `value of '${name}' must not contain "{{" or "}}" (substitution is a single pass)`);
    else clean[name] = value;
  }
  return clean;
}

function readJson(dir: string, relative: string, add: Collect): unknown {
  const path = join(dir, relative);
  let size: number;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return void add(relative, '', 'not_a_file', 'must be a regular file (symbolic links are not followed)');
    size = stat.size;
  } catch {
    return void add(relative, '', 'missing', 'file not found');
  }
  if (size > MAX_FILE_BYTES) return void add(relative, '', 'too_large', `file is larger than ${MAX_FILE_BYTES} bytes`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    return void add(relative, '', 'json', `not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** manifest 가 가리키는 디렉터리의 `*.json` 을 이름순으로 읽는다. 디렉터리를 선언하지 않았으면 없는 것이다. 파일 이름(확장자 제외)은 `identity` 필드와 같아야 한다 */
function readDeclarations(dir: string, manifest: PackManifest, key: PackContentKey, identity: string, add: Collect): { file: string; data: unknown }[] {
  const declared = manifest.contents?.[key];
  if (declared === undefined) return [];
  const relative = declared.replace(/\/+$/, '');
  const absolute = join(dir, relative);
  let names: string[];
  try {
    if (!lstatSync(absolute).isDirectory()) throw new Error('not a directory');
    names = readdirSync(absolute).filter((name) => name.endsWith('.json')).sort();
  } catch {
    add('manifest.json', `contents.${key}`, 'missing_dir', `directory '${declared}' does not exist (or is not a plain directory)`);
    return [];
  }
  const out: { file: string; data: unknown }[] = [];
  for (const name of names) {
    const file = `${relative}/${name}`;
    const data = readJson(dir, file, add);
    if (data === undefined) continue;
    const expected = name.slice(0, -'.json'.length);
    if (isPlainObject(data) && data[identity] !== expected) {
      add(file, identity, 'file_name', `'${identity}' must equal the file name '${expected}'`);
      continue;
    }
    out.push({ file, data });
  }
  return out;
}

/** 문자열 값 안의 `{{name}}` 을 바꾼다. 키는 바꾸지 않는다(키에 자리표시자가 있으면 거부) */
function substitute(value: unknown, values: Readonly<Record<string, string>>, file: string, path: string, add: Collect): unknown {
  if (typeof value === 'string') {
    const replaced = value.replace(PLACEHOLDER, (match, name: string) => {
      if (Object.hasOwn(values, name)) return values[name]!;
      add(file, path, 'unresolved_placeholder', `placeholder '${match}' has no value in pack_values`);
      return match;
    });
    if (value.replace(PLACEHOLDER, '').match(/\{\{|\}\}/)) add(file, path, 'malformed_placeholder', 'stray "{{" or "}}" (a placeholder looks like {{name}} with lowercase letters, digits, underscores)');
    return replaced;
  }
  if (Array.isArray(value)) return value.map((item: unknown, index) => substitute(item, values, file, `${path}[${index}]`, add));
  if (isPlainObject(value)) {
    const out: PlainObject = {};
    for (const [key, item] of Object.entries(value)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      if (key.includes('{{') || key.includes('}}')) add(file, childPath, 'placeholder_in_key', 'placeholders are only substituted in values, not in keys');
      out[key] = substitute(item, values, file, childPath, add);
    }
    return out;
  }
  return value;
}

function unknownKeys(obj: PlainObject, allowed: readonly string[], file: string, base: string, add: Collect): void {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) add(file, base === '' ? key : `${base}.${key}`, 'unknown_field', `unknown field '${key}'`);
}

function loadTemplate(file: string, raw: unknown, values: Readonly<Record<string, string>>, add: Collect): PackTemplate | undefined {
  const before = add.count;
  if (!isPlainObject(raw)) return void add(file, '', 'type', 'template must be a JSON object');
  unknownKeys(raw, TEMPLATE_KEYS, file, '', add);
  const id = raw['id'];
  if (typeof id !== 'string' || !NAME.test(id)) add(file, 'id', 'format', 'id must be lowercase letters, digits and hyphens');
  const version = raw['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) add(file, 'version', 'range', 'version must be an integer >= 1');
  const description = raw['description'];
  if (description !== undefined && !isNonBlankString(description)) add(file, 'description', 'type', 'description must be a non-empty string');
  const tasks = raw['tasks'];
  if (!Array.isArray(tasks) || tasks.length === 0) return void add(file, 'tasks', 'required', 'tasks must be a non-empty array');

  const names = new Set<string>();
  const parsed: PackTemplateTask[] = [];
  tasks.forEach((task: unknown, index) => {
    const path = `tasks[${index}]`;
    if (!isPlainObject(task)) return void add(file, path, 'type', 'each task must be an object {name, depends_on?, spec}');
    unknownKeys(task, TASK_KEYS, file, path, add);
    const name = task['name'];
    if (typeof name !== 'string' || !NAME.test(name)) add(file, `${path}.name`, 'format', 'name must be lowercase letters, digits and hyphens');
    else if (names.has(name)) add(file, `${path}.name`, 'duplicate', `task name '${name}' is used more than once`);
    else names.add(name);
    const depends = task['depends_on'] ?? [];
    if (!Array.isArray(depends) || depends.some((d: unknown) => typeof d !== 'string')) add(file, `${path}.depends_on`, 'type', 'depends_on must be an array of task names');
    const spec = task['spec'];
    if (!isPlainObject(spec)) return void add(file, `${path}.spec`, 'type', 'spec must be a task-spec draft object');
    for (const field of ENGINE_OWNED_SPEC_FIELDS) {
      if (field in spec) add(file, `${path}.spec.${field}`, 'engine_field', `'${field}' is filled by the engine when the routine fires; a template cannot specify it`);
    }
    parsed.push({
      name: typeof name === 'string' ? name : '',
      dependsOn: Array.isArray(depends) ? (depends as string[]) : [],
      spec: substitute(spec, values, file, `${path}.spec`, add) as PlainObject,
    });
  });
  checkTaskGraph(parsed, file, add);
  checkResultInputs(parsed, file, add);
  if (add.count > before) return undefined;
  return { id: id as string, version: version as number, description: typeof description === 'string' ? description : null, tasks: parsed };
}

/**
 * `task_result` 입력(A6-U11): 템플릿 안에서는 `task:<같은 템플릿의 업무 name>` 으로만 쓴다(업무 id 는 발화할 때 생기므로 이미 있는 id 를 적을 수 없다).
 * 그 업무는 `depends_on` 에도 있어야 한다. 형식(`task:<id>`, 중복, 개수)은 `validateTaskSpec` 이 본다.
 */
function checkResultInputs(tasks: readonly PackTemplateTask[], file: string, add: Collect): void {
  const names = new Set(tasks.map((task) => task.name));
  tasks.forEach((task, index) => {
    const inputs = task.spec['inputs'];
    if (!Array.isArray(inputs)) return;
    inputs.forEach((item: unknown, inputIndex) => {
      if (!isPlainObject(item) || item['kind'] !== TASK_RESULT_INPUT_KIND || typeof item['ref'] !== 'string' || !item['ref'].startsWith(TASK_RESULT_REF_PREFIX)) return;
      const name = item['ref'].slice(TASK_RESULT_REF_PREFIX.length);
      const path = `tasks[${index}].spec.inputs[${inputIndex}].ref`;
      if (!names.has(name)) add(file, path, 'not_found', `a template can read the result of a task of the same template only; '${name}' is not one`);
      else if (!task.dependsOn.includes(name)) add(file, path, 'upstream_not_a_dependency', `task '${task.name}' reads the result of '${name}', which must be in its depends_on`);
    });
  });
}

/** 알 수 없는 선행, 자기 의존, 순환 */
function checkTaskGraph(tasks: readonly PackTemplateTask[], file: string, add: Collect): void {
  const names = new Set(tasks.map((task) => task.name));
  let broken = false;
  tasks.forEach((task, index) => {
    for (const dep of task.dependsOn) {
      if (dep === task.name) { add(file, `tasks[${index}].depends_on`, 'cycle', `task '${task.name}' depends on itself`); broken = true; }
      else if (!names.has(dep)) { add(file, `tasks[${index}].depends_on`, 'not_found', `task '${task.name}' depends on unknown task '${dep}'`); broken = true; }
    }
  });
  if (broken) return;
  const placed = new Set<string>();
  while (placed.size < tasks.length) {
    const next = tasks.find((task) => !placed.has(task.name) && task.dependsOn.every((dep) => placed.has(dep)));
    if (!next) {
      add(file, 'tasks', 'cycle', `dependency cycle among: ${tasks.filter((task) => !placed.has(task.name)).map((task) => task.name).join(', ')}`);
      return;
    }
    placed.add(next.name);
  }
}

function loadRoutine(file: string, raw: unknown, values: Readonly<Record<string, string>>, add: Collect): PackRoutine | undefined {
  const before = add.count;
  if (!isPlainObject(raw)) return void add(file, '', 'type', 'routine must be a JSON object');
  unknownKeys(raw, ROUTINE_KEYS, file, '', add);
  const substituted = substitute(raw, values, file, '', add) as PlainObject;
  const text = (key: string, required: boolean): string | undefined => {
    const value = substituted[key];
    if (value === undefined && !required) return undefined;
    if (!isNonBlankString(value)) return void add(file, key, 'required', `${key} must be a non-empty string`);
    return value;
  };
  const slug = text('slug', true);
  if (slug !== undefined && !NAME.test(slug)) add(file, 'slug', 'format', 'slug must be lowercase letters, digits and hyphens');
  const description = text('description', false);
  const schedule = text('schedule', true);
  if (schedule !== undefined) {
    try {
      parseSchedule(schedule);
    } catch (error) {
      if (!(error instanceof ScheduleError)) throw error;
      add(file, 'schedule', 'schedule', error.message);
    }
  }
  const catchUp = substituted['catch_up'];
  if (catchUp !== 'skip' && catchUp !== 'run_once') add(file, 'catch_up', 'enum', "catch_up must be 'skip' or 'run_once' (state it explicitly)");
  const taskTemplate = text('task_template', true);
  if (taskTemplate !== undefined && !TEMPLATE_REF.test(taskTemplate)) add(file, 'task_template', 'format', 'task_template must look like "<template-id>@<version>"');
  const orgUnit = text('org_unit', true);
  const product = text('product', false);
  if (add.count > before) return undefined;
  return {
    slug: slug!, description: description ?? null, schedule: schedule!, catchUp: catchUp as CatchUpMode, taskTemplate: taskTemplate!, orgUnit: orgUnit!, product: product ?? null,
  };
}

const PROBE_SCHEDULED_FOR = '2000-01-03T00:00:00.000Z';

function specWithTrigger(spec: PlainObject, slug: string, scheduledFor: string): PlainObject {
  return { ...structuredClone(spec), trigger: { kind: 'routine', ref: `${slug}@${scheduledFor}` } };
}

function probeTemplate(template: PackTemplate): Issue[] {
  const issues: Issue[] = [];
  template.tasks.forEach((task, index) => {
    const result = validateTaskSpec(specWithTrigger(task.spec, 'probe', PROBE_SCHEDULED_FOR), 'draft');
    if (!result.ok) for (const e of result.errors) issues.push({ path: `tasks[${index}].spec${e.path === '' ? '' : `.${e.path}`}`, code: e.code, message: e.message });
  });
  return issues;
}

function createTemplateSource(byRef: ReadonlyMap<string, PackTemplate>): PackTemplateSource {
  return {
    resolve(request: RoutineTemplateRequest): readonly RoutineTemplateTask[] {
      const template = byRef.get(request.routine.taskTemplate);
      if (template === undefined) throw new Error(`pack has no template '${request.routine.taskTemplate}'`);
      const issues: Issue[] = [];
      const tasks = template.tasks.map((task, index): RoutineTemplateTask => {
        const spec = specWithTrigger(task.spec, request.routine.slug, request.scheduledFor);
        const result = validateTaskSpec(spec, 'draft');
        if (!result.ok) for (const e of result.errors) issues.push({ path: `tasks[${index}].spec${e.path === '' ? '' : `.${e.path}`}`, code: e.code, message: e.message });
        return { name: task.name, spec, dependsOn: [...task.dependsOn] };
      });
      // 결정적인 거부다: 같은 값으로는 다시 시도해도 같다. 호출자(RoutineFirer)가 이 슬롯을 다시 시도하지 않는다.
      if (issues.length > 0) throw new TaskCreationError(issues);
      return tasks;
    },
  };
}

export interface PackSyncResult {
  created: string[];
  updated: string[];
  unchanged: string[];
}

type RoutineDbRow = { id: string; org_unit_id: string; product_id: string | null; schedule: string; task_template: string; catch_up: string; enabled: number };

/** 팩의 루틴 선언을 DB 에 멱등으로 반영한다 (규칙은 파일 머리말). 하나라도 거부되면 아무것도 쓰지 않는다 */
export function syncPackRoutines(db: Db, pack: Pick<LoadedPack, 'routines'>): PackSyncResult {
  return db.writeTx((tx) => {
    const result: PackSyncResult = { created: [], updated: [], unchanged: [] };
    for (const routine of pack.routines) {
      const unit = tx.get<{ id: string }>('SELECT id FROM org_unit WHERE slug = ?', [routine.orgUnit]);
      if (!unit) throw new PackSyncError('unknown_org_unit', routine.slug, `org_unit '${routine.orgUnit}' does not exist`);
      let productId: string | null = null;
      if (routine.product !== null) {
        const product = tx.get<{ id: string; registration_status: string }>('SELECT id, registration_status FROM product WHERE slug = ?', [routine.product]);
        if (!product) throw new PackSyncError('unknown_product', routine.slug, `product '${routine.product}' does not exist`);
        // registered 가 아닌 product 는 product_id 가 가리킬 수 없다 (schema.sql 의 애플리케이션 규칙, 업무 생성의 product 검사와 같다)
        if (product.registration_status !== 'registered') {
          throw new PackSyncError('product_not_registered', routine.slug, `product '${routine.product}' is '${product.registration_status}'; only a registered product can be referenced`);
        }
        productId = product.id;
      }
      const existing = tx.get<RoutineDbRow>(
        'SELECT id, org_unit_id, product_id, schedule, task_template, catch_up, enabled FROM routine WHERE slug = ?', [routine.slug],
      );
      if (!existing) {
        tx.run(
          'INSERT INTO routine (id, slug, org_unit_id, schedule, task_template, catch_up, enabled, product_id) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
          [`routine-${routine.slug}`, routine.slug, unit.id, routine.schedule, routine.taskTemplate, routine.catchUp, productId],
        );
        result.created.push(routine.slug);
        continue;
      }
      const differing = [
        existing.org_unit_id !== unit.id ? 'org_unit' : null,
        existing.product_id !== productId ? 'product' : null,
        existing.schedule !== routine.schedule ? 'schedule' : null,
        existing.task_template !== routine.taskTemplate ? 'task_template' : null,
        existing.catch_up !== routine.catchUp ? 'catch_up' : null,
      ].filter((field): field is string => field !== null);
      if (differing.length === 0) {
        result.unchanged.push(routine.slug);
        continue;
      }
      if (existing.enabled !== 0) {
        throw new PackSyncError(
          'routine_enabled_conflict', routine.slug,
          `the pack declares different ${differing.join(', ')} but the routine is enabled; a change to an approved routine goes through its own approval, not a pack edit`,
        );
      }
      tx.run(
        'UPDATE routine SET org_unit_id = ?, product_id = ?, schedule = ?, task_template = ?, catch_up = ? WHERE id = ? AND enabled = 0',
        [unit.id, productId, routine.schedule, routine.taskTemplate, routine.catchUp, existing.id],
      );
      result.updated.push(routine.slug);
    }
    return result;
  });
}
