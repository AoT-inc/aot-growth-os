// task-engine 시험 공용: 허용 정책 훅, 손으로 돌리는 타이머, 가짜 도구 → EffectTool 연결, 업무 하나 만들기.
import type { Db, FakeClock, TaskPolicyGate } from '@aot/domain';
import { createTask, type EffectActionDeclaration, type EffectCall, type EffectTool, type Timers } from '@aot/task-engine';

import { FakeToolTimeoutError, type FakeTool } from './fake-tool.ts';
import { minimalDraft } from './spec-fixtures.ts';

/** 시험용: 생성·실행을 모두 허용한다. 실제 판정은 A3 의 policy 가 같은 포트로 구현한다. */
export const ALLOW_ALL_GATE: TaskPolicyGate = {
  beforeCreate: () => ({ decision: 'allow' }),
  beforeRun: () => ({ decision: 'allow' }),
  beforeEffect: () => ({ decision: 'allow' }),
};

/** setInterval 이 저절로 불리지 않는 타이머. `fire()` 를 부를 때만 등록된 콜백이 돈다. */
export function manualTimers(): Timers & { fire(): void; readonly active: number } {
  const callbacks = new Map<number, () => void>();
  let next = 1;
  return {
    setInterval(fn) {
      const id = next++;
      callbacks.set(id, fn);
      return id;
    },
    clearInterval(handle) {
      callbacks.delete(handle as number);
    },
    fire() {
      for (const fn of [...callbacks.values()]) fn();
    },
    get active() {
      return callbacks.size;
    },
  };
}

export interface EffectToolHooks {
  /** send 시작 시(= beginDispatch 가 dispatched 를 기록한 뒤, 가짜 도구 호출 전) 부른다 */
  beforeSend?: (call: EffectCall) => Promise<void> | void;
  /** 외부에 부작용을 일으킨 직후, 응답을 돌려주기 전에 부른다 (응답 전 프로세스 종료를 흉내 낼 때) */
  afterDelivery?: () => Promise<void> | void;
}

/** test/support/fake-tool.ts 의 가짜 도구를 엔진의 EffectTool 계약에 맞춘다. 응답 유실은 예외 → `unknown`. */
export function asEffectTool(fake: FakeTool, hooks: EffectToolHooks = {}, actionNames: readonly string[] = ['send']): EffectTool {
  const actions: Record<string, EffectActionDeclaration> = Object.fromEntries(actionNames.map((name) => [
    name, { idempotency: fake.idempotency, ...(fake.lookup ? { effect_key_carrier: 'metadata' as const } : {}) },
  ]));
  const tool: EffectTool = {
    name: fake.name,
    actions,
    async send(call) {
      await hooks.beforeSend?.(call);
      let response;
      try {
        response = fake.call({ effectKey: call.effectKey, payload: call.request });
      } catch (error) {
        if (error instanceof FakeToolTimeoutError) await hooks.afterDelivery?.();
        throw error;
      }
      await hooks.afterDelivery?.();
      return { status: 'confirmed', responseRef: response.deliveryId };
    },
  };
  const lookup = fake.lookup;
  if (lookup) {
    tool.lookup = (effectKey) => {
      const found = lookup(effectKey);
      return found ? { found: true, responseRef: found.deliveryId } : { found: false };
    };
  }
  return tool;
}

/** 시드된 DB 에 generalist 역할의 queued 업무 하나를 만든다. */
export function queuedTask(db: Db, clock: FakeClock, overrides: Record<string, unknown> = {}, id?: string): string {
  const spec = { ...minimalDraft(), role: 'generalist', ...overrides };
  return createTask(db, { clock, gate: ALLOW_ALL_GATE }, { spec, ...(id === undefined ? {} : { id }) }).taskId;
}

export const taskStatus = (db: Db, taskId: string): string => String(db.get('SELECT status FROM task WHERE id = ?', [taskId])?.['status']);

export const runsOf = (db: Db, taskId: string) =>
  db.all<{ id: string; attempt: number; outcome: string | null; lease_owner: string }>(
    'SELECT id, attempt, outcome, lease_owner FROM task_run WHERE task_id = ? ORDER BY attempt', [taskId],
  ).map((r) => ({ ...r, attempt: Number(r.attempt) }));

export const effectsOf = (db: Db, taskId: string) =>
  db.all<{ id: string; state: string; task_run_id: string; supports_idempotency: number; planned_at: string }>(
    'SELECT id, state, task_run_id, supports_idempotency, planned_at FROM external_effect WHERE task_id = ? ORDER BY at, id', [taskId],
  ).map((r) => ({ ...r, supports_idempotency: Number(r.supports_idempotency) }));
