// task_spec 의 참조 검증: 역할·부서·상품·선행 업무가 실제로 있고 쓸 수 있는 상태인가 (task-spec.md "생성 거부 조건").
// DB 읽기만 한다. 업무를 만드는 쪽(A2)이 스키마 검증 뒤에 호출한다.
import type { Db } from '../db/types.ts';
import type { Issue } from '../validation.ts';
import { taskTypeOf } from '../org.ts';
import type { TaskSpecDraft } from './task-spec.ts';

const ASSIGNABLE_ROLE_LIFECYCLES = ['trial', 'active'];

/**
 * 문제가 없으면 빈 배열. department/role 을 비워 둔 것은 문제가 아니라 `unassigned` 생성 대상이다.
 * trial 역할은 `trial_scope.task_types` 에 든 업무 유형만 받는다(ADR-0011 §7, 업무 유형 = `taskTypeOf`). 정책 판정은 여기서 하지 않는다.
 */
export function checkTaskSpecReferences(db: Db, spec: Pick<TaskSpecDraft, 'department' | 'role' | 'product' | 'dependencies'> & { trigger?: { kind: string; ref: string } }): Issue[] {
  const issues: Issue[] = [];

  if (spec.department !== undefined) {
    const unit = db.get('SELECT 1 AS one FROM org_unit WHERE slug = ?', [spec.department]);
    if (!unit) issues.push({ path: 'department', code: 'not_found', message: `department '${spec.department}' does not exist` });
  }

  if (spec.role !== undefined) {
    const role = db.get<{ lifecycle: string; trial_scope: string | null }>('SELECT lifecycle, trial_scope FROM role WHERE slug = ?', [spec.role]);
    if (!role) {
      issues.push({ path: 'role', code: 'not_found', message: `role '${spec.role}' does not exist` });
    } else if (!ASSIGNABLE_ROLE_LIFECYCLES.includes(role.lifecycle)) {
      issues.push({ path: 'role', code: 'not_assignable', message: `role '${spec.role}' is '${role.lifecycle}'; only trial/active roles can receive tasks` });
    } else if (role.lifecycle === 'trial') {
      const type = spec.trigger === undefined ? 'manual' : taskTypeOf(spec.trigger);
      if (!trialTaskTypes(role.trial_scope).includes(type)) {
        issues.push({ path: 'role', code: 'out_of_trial_scope', message: `role '${spec.role}' is in trial and only receives task types [${trialTaskTypes(role.trial_scope).join(', ')}]; this task is '${type}'` });
      }
    }
  }

  if (spec.product !== undefined) {
    const product = db.get<{ registration_status: string }>('SELECT registration_status FROM product WHERE slug = ?', [spec.product]);
    if (!product || product.registration_status !== 'registered') {
      issues.push({ path: 'product', code: 'not_registered', message: `product '${spec.product}' is not registered` });
    }
  }

  (spec.dependencies ?? []).forEach((id, index) => {
    if (!db.get('SELECT 1 AS one FROM task WHERE id = ?', [id])) {
      issues.push({ path: `dependencies[${index}]`, code: 'not_found', message: `dependency '${id}' does not exist` });
    }
  });

  return issues;
}

/** `role.trial_scope` JSON 에서 업무 유형 목록 (없거나 깨졌으면 빈 목록 = 아무것도 받지 않는다) */
export function trialTaskTypes(trialScope: string | null): string[] {
  if (trialScope === null) return [];
  try {
    const parsed = JSON.parse(trialScope) as { task_types?: unknown };
    return Array.isArray(parsed.task_types) ? parsed.task_types.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
