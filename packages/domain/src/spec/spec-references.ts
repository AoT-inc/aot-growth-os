// task_spec 의 참조 검증: 역할·부서·상품·선행 업무가 실제로 있고 쓸 수 있는 상태인가 (task-spec.md "생성 거부 조건").
// DB 읽기만 한다. 업무를 만드는 쪽(A2)이 스키마 검증 뒤에 호출한다.
import type { Db } from '../db/types.ts';
import type { Issue } from '../validation.ts';
import type { TaskSpecDraft } from './task-spec.ts';

const ASSIGNABLE_ROLE_LIFECYCLES = ['trial', 'active'];

/**
 * 문제가 없으면 빈 배열. department/role 을 비워 둔 것은 문제가 아니라 `unassigned` 생성 대상이다.
 * trial 역할의 `trial_scope` 확인(업무 유형)과 정책 판정은 여기서 하지 않는다.
 */
export function checkTaskSpecReferences(db: Db, spec: Pick<TaskSpecDraft, 'department' | 'role' | 'product' | 'dependencies'>): Issue[] {
  const issues: Issue[] = [];

  if (spec.department !== undefined) {
    const unit = db.get('SELECT 1 AS one FROM org_unit WHERE slug = ?', [spec.department]);
    if (!unit) issues.push({ path: 'department', code: 'not_found', message: `department '${spec.department}' does not exist` });
  }

  if (spec.role !== undefined) {
    const role = db.get<{ lifecycle: string }>('SELECT lifecycle FROM role WHERE slug = ?', [spec.role]);
    if (!role) {
      issues.push({ path: 'role', code: 'not_found', message: `role '${spec.role}' does not exist` });
    } else if (!ASSIGNABLE_ROLE_LIFECYCLES.includes(role.lifecycle)) {
      issues.push({ path: 'role', code: 'not_assignable', message: `role '${spec.role}' is '${role.lifecycle}'; only trial/active roles can receive tasks` });
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
