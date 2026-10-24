// 업무 생성 엔진: 업무가 만들어지는 유일한 입구 (ADR-0004). 이벤트·루틴·수동 생성 모두 여기를 거친다.
// 멱등성 (docs/operations/recovery.md §1 "업무 생성")
//  - 이벤트: event.idempotency_key UNIQUE — 같은 키는 몇 번 와도 event 1건, task 1건
//  - 루틴:   routine_firing (routine_id, scheduled_for) PK — 같은 발화는 한 번만
//  - 업무:   task.dedupe_key 활성 유일 인덱스 — 같은 트리거·같은 입력의 활성 업무는 1건 (ADR-0004)
// 생성 거부 조건은 docs/schema/task-spec.md 표: 스키마(validateTaskSpec), 참조(checkTaskSpecReferences),
// 의존 순환(여기), 정책 판정(TaskPolicyGate.beforeCreate, A3 — 거부 판정은 롤백 뒤에도 기록한다).
import { randomUUID } from 'node:crypto';

import {
  checkTaskSpecReferences, currentFacts, currentPolicyVersionId, getMemoryItem, isCurrentFact, isPlainObject, MEMORY_INPUT_KIND, parseMemoryRef, TASK_RESULT_INPUT_KIND, TASK_RESULT_REF_PREFIX, taskIdOfResultRef, validateTaskSpec,
  type Clock, type Db, type Issue, type TaskPolicyGate, type TaskSpec, type TaskSpecDraft, type TaskStatus, type TriggerKind,
} from '@aot/domain';

import { canonicalJson, sha256 } from './canonical.ts';
import { TaskCreationError } from './errors.ts';
import { recordTaskCreation } from './transitions.ts';

export interface CreateContext {
  clock: Clock;
  gate: TaskPolicyGate;
  newId?: () => string;
}

export interface CreateTaskInput {
  /** 작성자가 낸 명세 (draft). 시스템 필드는 엔진이 채운다 */
  spec: unknown;
  /** 기본: hash(trigger, inputs) — "동일 트리거·동일 입력" (ADR-0004) */
  dedupeKey?: string;
  /** 업무 id 를 미리 정할 때 (기본은 새 id) */
  id?: string;
  /** 명세 템플릿 버전 (task.task_spec_version, 기본 1) */
  taskSpecVersion?: number;
  /** 기본은 스키마 기본값 3 */
  maxAttempts?: number;
  causedBy?: string;
  /**
   * 이 업무가 속한 전략 (A6-U15: 실험 활성화가 만든 업무·실험 루틴이 발화한 업무). 주면 `task.strategy_version_id` 와 `versions.strategy_version` 이 이 값이다.
   * 생략하면 이전과 같이 `active` 전략(없으면 null)이다.
   */
  strategyVersionId?: string;
}

export interface CreateTaskResult {
  /** false 면 같은 dedupe_key 의 활성 업무가 이미 있어 그것을 돌려준다 */
  created: boolean;
  taskId: string;
  status: TaskStatus;
}

export function createTask(db: Db, context: CreateContext, input: CreateTaskInput): CreateTaskResult {
  return withRefusalRecord(db, () => db.writeTx((tx) => createTaskInTx(tx, context, input)));
}

/**
 * 정책이 생성을 거부하면 생성 트랜잭션은 되돌려진다. 거부 판정도 policy_decision 에 남아야 하므로(ADR-0006)
 * 롤백 뒤 새 쓰기 트랜잭션에서 기록하고 원래 오류를 다시 던진다.
 */
export function withRefusalRecord<T>(db: Db, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof TaskCreationError && error.recordRefusal && !db.inWriteTx) {
      const record = error.recordRefusal;
      db.writeTx((tx) => record(tx));
    }
    throw error;
  }
}

/** 쓰기 트랜잭션 안에서 업무를 만든다. 이벤트·루틴 기록과 같은 트랜잭션에 묶을 때 쓴다. */
export function createTaskInTx(tx: Db, context: CreateContext, input: CreateTaskInput): CreateTaskResult {
  const now = context.clock.nowIso();
  const checked = validateTaskSpec(input.spec, 'draft');
  if (!checked.ok) throw new TaskCreationError(checked.errors);
  const original = checked.value;

  // 같은 트리거·같은 입력의 판정은 작성자가 낸 입력(선택자 그대로)으로 한다: 기억 선택자가 시간이 지나 다른 항목을 가리켜도 같은 발화는 같은 업무다.
  const dedupeKey = input.dedupeKey ?? sha256(canonicalJson({ trigger: original.trigger, inputs: original.inputs }));
  const existing = tx.get<{ id: string; status: TaskStatus }>(
    "SELECT id, status FROM task WHERE dedupe_key = ? AND status NOT IN ('completed', 'failed', 'cancelled')",
    [dedupeKey],
  );
  if (existing) return { created: false, taskId: existing.id, status: existing.status };
  const draft = resolveMemoryInputs(tx, context.clock, original);

  const taskId = input.id ?? context.newId?.() ?? `task-${randomUUID()}`;
  if (tx.get('SELECT 1 AS one FROM task WHERE id = ?', [taskId])) {
    throw new TaskCreationError([{ path: 'id', code: 'duplicate', message: `task '${taskId}' already exists` }]);
  }
  // 선행 업무의 결과를 입력으로 받으려면 그 업무가 dependencies 에도 있어야 한다: 실행 순서(선행이 completed 가 된 뒤에야 집힌다)가 dependencies 로 보장된다.
  // 자동으로 더하지 않고 거부한다 — 의존 관계는 작성자가 밝힌 것만 믿는다.
  const dependencySet = new Set(draft.dependencies ?? []);
  const upstreamIssues: Issue[] = [];
  draft.inputs.forEach((input, index) => {
    if (input.kind !== TASK_RESULT_INPUT_KIND) return;
    const upstreamId = taskIdOfResultRef(input.ref);
    if (upstreamId !== null && !dependencySet.has(upstreamId)) {
      upstreamIssues.push({ path: `inputs[${index}].ref`, code: 'upstream_not_a_dependency', message: `'${input.ref}' must also be listed in dependencies` });
    }
  });
  if (upstreamIssues.length > 0) throw new TaskCreationError(upstreamIssues);
  const cycle = findDependencyCycle(tx, taskId, draft.dependencies ?? []);
  if (cycle) {
    throw new TaskCreationError([{ path: 'dependencies', code: 'cycle', message: `dependency cycle: ${cycle.join(' -> ')}` }]);
  }
  const referenceIssues = checkTaskSpecReferences(tx, draft);
  if (referenceIssues.length > 0) throw new TaskCreationError(referenceIssues);

  if (input.strategyVersionId !== undefined && !tx.get('SELECT 1 AS one FROM strategy_version WHERE id = ?', [input.strategyVersionId])) {
    throw new TaskCreationError([{ path: 'strategy_version', code: 'not_found', message: `strategy_version '${input.strategyVersionId}' does not exist` }]);
  }
  const filled = fillSystemFields(tx, draft, input.taskSpecVersion ?? 1, input.strategyVersionId);
  const stored = validateTaskSpec(filled.spec, 'stored');
  if (!stored.ok) throw new TaskCreationError(stored.errors);

  // 역할이 없으면 unassigned (조직 관리팀의 재편 신호). 역할의 배정 가능 여부는 참조 검증이 이미 확인했다.
  const status: TaskStatus = filled.role ? 'queued' : 'unassigned';
  tx.run(
    `INSERT INTO task (id, dedupe_key, objective, org_unit_id, role_id, role_version, org_version_id, product_id,
       trigger_kind, trigger_ref, spec, task_spec_version, tool_contract_version, status, policy_version_id,
       strategy_version_id, cost_budget_usd, attempts, max_attempts, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
    [
      taskId, dedupeKey, draft.objective, filled.orgUnitId, filled.role?.id ?? null, filled.role?.version ?? null,
      filled.orgVersionId, filled.productId, draft.trigger.kind, draft.trigger.ref, JSON.stringify(filled.spec),
      input.taskSpecVersion ?? 1, status, filled.spec.policy_version, filled.strategyVersionId, draft.cost_budget.max_usd,
      input.maxAttempts ?? 3, now, now,
    ],
  );
  for (const dependsOn of draft.dependencies ?? []) {
    tx.run('INSERT INTO task_dependency (task_id, depends_on) VALUES (?, ?)', [taskId, dependsOn]);
  }
  // 정책 판정은 task 행이 생긴 뒤에 한다 (policy_decision.task_id 가 업무를 가리키게). 거부면 트랜잭션 전체가 되돌려지고,
  // 거부 판정 기록은 호출자(createTask 등)가 롤백 뒤에 남긴다.
  const verdict = context.gate.beforeCreate(tx, { spec: filled.spec, taskId, now });
  if (verdict.decision !== 'allow') {
    throw new TaskCreationError([{ path: 'allowed_tools', code: 'policy_denied', message: verdict.reason }], verdict.recordRefusal);
  }
  recordTaskCreation(tx, {
    taskId, to: status, by: 'task_creator', now,
    reason: status === 'queued' ? 'created' : 'created without an assignable role',
    ...(input.causedBy === undefined ? {} : { causedBy: input.causedBy }),
  });
  return { created: true, taskId, status };
}

/**
 * 기억 입력(`inputs[kind='memory']`, A6-U16)을 업무를 만드는 시점의 구체 참조로 바꾼다.
 *  - 선택자 `memory:latest#strategy_record`: 같은 상품의 가장 최근 *현재 사실* `strategy_record`(반증·만료·대체·미검증·외부 유래 항목은 `currentFacts` 가 이미 뺀다)의
 *    `memory:<id>` 로 바꾼다. 없으면 그 입력을 뺀다(선택 입력).
 *  - 구체 참조 `memory:<id>`: 항목이 있고 지금도 현재 사실이어야 한다. 아니면 생성을 거부한다(조용히 낡은 기억을 입력으로 삼지 않는다).
 * 저장되는 명세에는 구체 참조만 남아 승인 해시·감사가 같은 항목을 가리킨다. 항목 내용은 명세에 복사하지 않는다(참조만).
 */
function resolveMemoryInputs(tx: Db, clock: Clock, draft: TaskSpecDraft): TaskSpecDraft {
  if (!draft.inputs.some((item) => item.kind === MEMORY_INPUT_KIND)) return draft;
  const productId = draft.product === undefined ? null : tx.get<{ id: string }>('SELECT id FROM product WHERE slug = ?', [draft.product])?.id ?? null;
  const now = clock.nowIso();
  const issues: Issue[] = [];
  const inputs: TaskSpecDraft['inputs'] = [];
  draft.inputs.forEach((item, index) => {
    if (item.kind !== MEMORY_INPUT_KIND) {
      inputs.push(item);
      return;
    }
    const parsed = parseMemoryRef(item.ref);
    const path = `inputs[${index}].ref`;
    if (parsed === null) return void issues.push({ path, code: 'format', message: `'${item.ref}' is not a memory reference` });
    if ('latest' in parsed) {
      const latest = currentFacts(tx, { clock, kind: parsed.latest }).find((memory) => memory.product_id === productId);
      if (latest !== undefined) inputs.push({ ...item, ref: `memory:${latest.id}` });
      return;
    }
    const memory = getMemoryItem(tx, parsed.id);
    if (memory === undefined) return void issues.push({ path, code: 'not_found', message: `memory item '${parsed.id}' does not exist` });
    if (!isCurrentFact(memory, now)) {
      return void issues.push({ path, code: 'memory_not_current', message: `memory item '${parsed.id}' is not a current fact (refuted, superseded, expired or unverified); it cannot be a task input` });
    }
    inputs.push(item);
  });
  if (issues.length > 0) throw new TaskCreationError(issues);
  return { ...draft, inputs };
}

interface FilledSpec {
  spec: TaskSpec;
  role: { id: string; version: number; orgUnitId: string } | null;
  orgUnitId: string | null;
  orgVersionId: string | null;
  productId: string | null;
  strategyVersionId: string | null;
}

/** policy_version 과 versions 는 시스템만 채운다 (task-spec.md). */
function fillSystemFields(tx: Db, draft: TaskSpecDraft, taskSpecVersion: number, strategyVersionId?: string): FilledSpec {
  const policyVersion = currentPolicyVersionId(tx);
  if (policyVersion === null) {
    throw new TaskCreationError([{ path: 'policy_version', code: 'missing', message: 'no policy_version is deployed; seed the instance first' }]);
  }
  const role = draft.role === undefined
    ? undefined
    : tx.get<{ id: string; version: number; org_unit_id: string }>('SELECT id, version, org_unit_id FROM role WHERE slug = ?', [draft.role]);
  const unit = draft.department === undefined ? undefined : tx.get<{ id: string }>('SELECT id FROM org_unit WHERE slug = ?', [draft.department]);
  const orgVersion = tx.get<{ id: string }>("SELECT id FROM org_version WHERE status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1");
  const strategy = strategyVersionId !== undefined
    ? { id: strategyVersionId }
    : tx.get<{ id: string }>("SELECT id FROM strategy_version WHERE status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1");
  const product = draft.product === undefined ? undefined : tx.get<{ id: string }>('SELECT id FROM product WHERE slug = ?', [draft.product]);

  const spec: TaskSpec = {
    ...draft,
    policy_version: policyVersion,
    versions: {
      org_version: orgVersion?.id ?? null,
      role_version: role?.version ?? null,
      task_spec_version: taskSpecVersion,
      strategy_version: strategy?.id ?? null,
      tool_contract_version: null,
    },
  };
  return {
    spec,
    role: role ? { id: role.id, version: Number(role.version), orgUnitId: role.org_unit_id } : null,
    orgUnitId: unit?.id ?? role?.org_unit_id ?? null,
    orgVersionId: orgVersion?.id ?? null,
    productId: product?.id ?? null,
    strategyVersionId: strategy?.id ?? null,
  };
}

/**
 * 새 업무 `taskId` 가 `dependencies` 를 선행으로 가지면 순환이 생기는가.
 * task_dependency(task_id → depends_on) 간선을 따라가며 자기 자신에 닿거나, 이미 저장된 순환에 닿으면 그 경로를 돌려준다.
 */
export function findDependencyCycle(db: Db, taskId: string, dependencies: readonly string[]): string[] | null {
  const done = new Set<string>();
  const onPath = new Set<string>();
  const path: string[] = [taskId];

  const visit = (node: string): string[] | null => {
    if (node === taskId || onPath.has(node)) return [...path, node];
    if (done.has(node)) return null;
    onPath.add(node);
    path.push(node);
    const next = db.all<{ depends_on: string }>('SELECT depends_on FROM task_dependency WHERE task_id = ? ORDER BY depends_on', [node]);
    for (const edge of next) {
      const found = visit(edge.depends_on);
      if (found) return found;
    }
    path.pop();
    onPath.delete(node);
    done.add(node);
    return null;
  };

  for (const dependency of dependencies) {
    const found = visit(dependency);
    if (found) return found;
  }
  return null;
}

// ===== 이벤트 =====

export interface IncomingEvent {
  source: string;
  type: string;
  payload: unknown;
  occurredAt: string;
  externalId?: string;
  /** 기본: `(source, external_id)`, external_id 가 없으면 내용 해시 (ADR-0004) */
  idempotencyKey?: string;
  productId?: string;
}

export interface RecordEventResult {
  /** false 면 같은 idempotency_key 의 이벤트가 이미 있어 아무것도 만들지 않았다 */
  created: boolean;
  eventId: string;
  /** 이 이벤트로 만들어진 업무 (없으면 null) */
  taskId: string | null;
}

export function eventIdempotencyKey(event: IncomingEvent): string {
  if (event.idempotencyKey !== undefined) return event.idempotencyKey;
  if (event.externalId !== undefined) return `${event.source}:${event.externalId}`;
  return `sha256:${sha256(canonicalJson({ source: event.source, type: event.type, payload: event.payload }))}`;
}

/**
 * 이벤트를 기록하고 업무를 만든다 (한 트랜잭션). `spec` 의 trigger 는 `{kind: 'event', ref: <event.id>}` 로 덮어쓴다.
 * 같은 키가 다시 오면 이벤트도 업무도 새로 만들지 않는다.
 */
export function recordEvent(db: Db, context: CreateContext, event: IncomingEvent, spec: Record<string, unknown>): RecordEventResult {
  const key = eventIdempotencyKey(event);
  return withRefusalRecord(db, () => db.writeTx((tx) => {
    const existing = tx.get<{ id: string }>('SELECT id FROM event WHERE idempotency_key = ?', [key]);
    if (existing) return { created: false, eventId: existing.id, taskId: taskByTrigger(tx, 'event', existing.id) };
    const eventId = context.newId?.() ?? `event-${randomUUID()}`;
    tx.run(
      `INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [eventId, event.source, event.externalId ?? null, event.type, JSON.stringify(event.payload), event.productId ?? null, key,
        event.occurredAt, context.clock.nowIso()],
    );
    const task = createTaskInTx(tx, context, { spec: { ...spec, trigger: { kind: 'event', ref: eventId } } });
    return { created: true, eventId, taskId: task.taskId };
  }));
}

// ===== 루틴 =====

export interface RoutineFiring {
  routineId: string;
  /** 발화 예정 시각 (UTC ISO). 같은 값의 발화는 한 번만 기록된다 */
  scheduledFor: string;
  /** 이 발화로 만든 업무가 속한 실험 전략 (A6-U15, 실험 활성화가 켠 루틴). 생략하면 createTask 기본값 */
  strategyVersionId?: string | null;
}

export interface FireRoutineResult {
  created: boolean;
  taskId: string | null;
}

/** 루틴을 발화할 수 있는 상태인가를 확인하고 slug 를 돌려준다 (없음·비활성은 생성 거부) */
function requireEnabledRoutine(tx: Db, routineId: string): string {
  const routine = tx.get<{ slug: string; enabled: number }>('SELECT slug, enabled FROM routine WHERE id = ?', [routineId]);
  if (!routine) throw new TaskCreationError([{ path: 'routine', code: 'not_found', message: `routine '${routineId}' does not exist` }]);
  if (Number(routine.enabled) !== 1) {
    throw new TaskCreationError([{ path: 'routine', code: 'disabled', message: `routine '${routine.slug}' is disabled` }]);
  }
  return routine.slug;
}

const firingExists = (tx: Db, firing: RoutineFiring): boolean =>
  tx.get('SELECT 1 AS one FROM routine_firing WHERE routine_id = ? AND scheduled_for = ?', [firing.routineId, firing.scheduledFor]) !== undefined;

const recordFiring = (tx: Db, context: CreateContext, firing: RoutineFiring): void => {
  tx.run('INSERT INTO routine_firing (routine_id, scheduled_for, fired_at) VALUES (?, ?, ?)', [firing.routineId, firing.scheduledFor, context.clock.nowIso()]);
};

/**
 * 루틴 발화 1건을 기록하고 업무를 만든다 (한 트랜잭션). trigger 는 `{kind: 'routine', ref: '<slug>@<scheduledFor>'}`.
 * 언제 발화할지(cron 계산, catch_up) 는 여기서 정하지 않는다 — 호출하는 쪽이 `scheduledFor` 를 넘긴다 (schedule.ts, routine.ts).
 */
export function fireRoutine(db: Db, context: CreateContext, firing: RoutineFiring, spec: Record<string, unknown>): FireRoutineResult {
  return withRefusalRecord(db, () => db.writeTx((tx) => {
    const slug = requireEnabledRoutine(tx, firing.routineId);
    const ref = `${slug}@${firing.scheduledFor}`;
    if (firingExists(tx, firing)) return { created: false, taskId: taskByTrigger(tx, 'routine', ref) };
    recordFiring(tx, context, firing);
    const task = createTaskInTx(tx, context, { spec: { ...spec, trigger: { kind: 'routine', ref } } });
    return { created: true, taskId: task.taskId };
  }));
}

/** 루틴 템플릿이 해석된 업무 하나. `dependsOn` 은 같은 템플릿 안의 다른 업무 `name` (생성된 업무 id 로 바뀌어 저장된다) */
export interface RoutineTemplateTask {
  /** 템플릿 안에서 유일한 이름 */
  name: string;
  /** 업무 명세 초안. `trigger` 는 엔진이 덮어쓰고, `dependencies`(기존 업무 id)가 있으면 `dependsOn` 으로 생긴 id 가 덧붙는다 */
  spec: Record<string, unknown>;
  dependsOn?: readonly string[];
}

export interface FireRoutineTasksResult {
  /** false 면 이 슬롯은 이미 발화되어 아무것도 만들지 않았다 */
  created: boolean;
  /** 이 슬롯으로 만든 업무 id (만든 순서 = 선행 업무가 먼저). 이미 발화된 슬롯이면 그때 만든 업무 전부 */
  taskIds: string[];
}

/**
 * 템플릿 하나가 업무 여러 개를 발화한다. 한 트랜잭션에서 `routine_firing` 1건과 모든 업무를 만들고, 하나라도 거부되면 전부 되돌린다
 * (발화 기록도 남지 않으므로 다음 tick 이 다시 시도할 수 있다). 업무마다 `dedupe_key` 에 이름을 넣어 같은 입력의 형제 업무가 하나로 합쳐지지 않게 한다.
 * 모든 업무의 trigger 는 `{kind: 'routine', ref: '<slug>@<scheduledFor>'}` 로 같다.
 */
export function fireRoutineTasks(db: Db, context: CreateContext, firing: RoutineFiring, tasks: readonly RoutineTemplateTask[]): FireRoutineTasksResult {
  return withRefusalRecord(db, () => db.writeTx((tx) => {
    const slug = requireEnabledRoutine(tx, firing.routineId);
    const ref = `${slug}@${firing.scheduledFor}`;
    if (firingExists(tx, firing)) return { created: false, taskIds: taskIdsByTrigger(tx, 'routine', ref) };
    const ordered = orderTemplateTasks(tasks);
    recordFiring(tx, context, firing);
    const trigger = { kind: 'routine', ref };
    const idByName = new Map<string, string>();
    const templateNames = new Set(ordered.map((task) => task.name));
    for (const task of ordered) {
      const own = task.spec['dependencies'];
      const dependencies = own === undefined || Array.isArray(own)
        ? [...(own ?? []), ...(task.dependsOn ?? []).map((name) => idByName.get(name)!)]
        : own;
      const created = createTaskInTx(tx, context, {
        spec: { ...task.spec, trigger, dependencies, ...bindTemplateResultRefs(task, templateNames, idByName) },
        dedupeKey: sha256(canonicalJson({ trigger, inputs: task.spec['inputs'] ?? null, template_task: task.name })),
        ...(firing.strategyVersionId === undefined || firing.strategyVersionId === null ? {} : { strategyVersionId: firing.strategyVersionId }),
      });
      idByName.set(task.name, created.taskId);
    }
    return { created: true, taskIds: ordered.map((task) => idByName.get(task.name)!) };
  }));
}

/**
 * 템플릿 업무의 `task_result` 입력 중 `task:<템플릿 업무 name>` 을 방금 만든 업무 id 로 바꾼다 (A6-U11). 템플릿 업무 이름이 아닌 참조는 그대로 둔다
 * (이미 있는 업무 id 로 보고 `createTaskInTx` 가 dependencies 에 있는지 확인한다). 이름은 가리키는데 `dependsOn` 에 없으면 거부한다.
 */
function bindTemplateResultRefs(task: RoutineTemplateTask, templateNames: ReadonlySet<string>, idByName: ReadonlyMap<string, string>): { inputs?: unknown[] } {
  const inputs = task.spec['inputs'];
  if (!Array.isArray(inputs)) return {};
  const issues: Issue[] = [];
  const bound = inputs.map((item: unknown, index) => {
    if (!isPlainObject(item) || item['kind'] !== TASK_RESULT_INPUT_KIND || typeof item['ref'] !== 'string' || !item['ref'].startsWith(TASK_RESULT_REF_PREFIX)) return item;
    const name = item['ref'].slice(TASK_RESULT_REF_PREFIX.length);
    if (!templateNames.has(name)) return item;
    const id = idByName.get(name);
    if (id === undefined || !(task.dependsOn ?? []).includes(name)) {
      issues.push({ path: `template.tasks['${task.name}'].spec.inputs[${index}].ref`, code: 'upstream_not_a_dependency', message: `template task '${task.name}' reads the result of '${name}', which must be listed in its dependsOn` });
      return item;
    }
    return { ...item, ref: `${TASK_RESULT_REF_PREFIX}${id}` };
  });
  if (issues.length > 0) throw new TaskCreationError(issues);
  return { inputs: bound };
}

/** 이름 중복·알 수 없는 선행·자기 의존·순환을 거부하고, 선행 업무가 먼저 오는 순서(입력 순서 유지)로 돌려준다 */
function orderTemplateTasks(tasks: readonly RoutineTemplateTask[]): RoutineTemplateTask[] {
  const issues: Issue[] = [];
  if (tasks.length === 0) issues.push({ path: 'template.tasks', code: 'empty', message: 'a routine template must resolve to at least one task' });
  const byName = new Map<string, RoutineTemplateTask>();
  tasks.forEach((task, i) => {
    if (typeof task.name !== 'string' || task.name === '') {
      issues.push({ path: `template.tasks[${i}].name`, code: 'required', message: 'template task name must be a non-empty string' });
    } else if (byName.has(task.name)) {
      issues.push({ path: `template.tasks[${i}].name`, code: 'duplicate', message: `template task name '${task.name}' is used more than once` });
    } else {
      byName.set(task.name, task);
    }
  });
  tasks.forEach((task, i) => {
    for (const dependency of task.dependsOn ?? []) {
      if (dependency === task.name) issues.push({ path: `template.tasks[${i}].dependsOn`, code: 'cycle', message: `template task '${task.name}' depends on itself` });
      else if (!byName.has(dependency)) issues.push({ path: `template.tasks[${i}].dependsOn`, code: 'not_found', message: `template task '${task.name}' depends on unknown template task '${dependency}'` });
    }
  });
  if (issues.length > 0) throw new TaskCreationError(issues);

  const ordered: RoutineTemplateTask[] = [];
  const placed = new Set<string>();
  while (ordered.length < tasks.length) {
    const next = tasks.find((task) => !placed.has(task.name) && (task.dependsOn ?? []).every((name) => placed.has(name)));
    if (!next) {
      const stuck = tasks.filter((task) => !placed.has(task.name)).map((task) => task.name);
      throw new TaskCreationError([{ path: 'template.tasks', code: 'cycle', message: `template dependency cycle among: ${stuck.join(', ')}` }]);
    }
    placed.add(next.name);
    ordered.push(next);
  }
  return ordered;
}

function taskIdsByTrigger(tx: Db, kind: TriggerKind, ref: string): string[] {
  return tx.all<{ id: string }>('SELECT id FROM task WHERE trigger_kind = ? AND trigger_ref = ? ORDER BY created_at, rowid', [kind, ref]).map((row) => row.id);
}

function taskByTrigger(tx: Db, kind: TriggerKind, ref: string): string | null {
  return tx.get<{ id: string }>('SELECT id FROM task WHERE trigger_kind = ? AND trigger_ref = ? ORDER BY created_at, rowid LIMIT 1', [kind, ref])?.id ?? null;
}

