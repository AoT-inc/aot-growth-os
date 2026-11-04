// 조직 변경 시험의 업무 배정 (Phase B / B3, ADR-0011 §7). 맞는 역할이 없어 `unassigned` 로 만들어진 업무를,
// 새로 생긴 `trial`/`active` 역할의 `trial_scope.task_types` 에 업무 유형이 들면 그 역할에 배정(`unassigned → queued`, 주체 scheduler)한다.
//  - 시드 역할은 `trial_scope` 가 없어 이 경로로 업무를 받지 않는다. 범위 밖 업무는 계속 `unassigned` 다(= 재편 신호).
//  - 같은 업무 유형에 맞는 역할이 여럿이면 slug 순으로 가장 앞선 것 하나. trial 역할이 active 역할보다 우선하지 않는다(slug 순서만).
//  - 배정은 업무 한 건마다 한 트랜잭션이 아니라 호출자의 쓰기 트랜잭션 안에서 한다(조직 주기 처리). 이미 queued 가 된 업무는 건드리지 않는다.
// 시각은 주입된 Clock 에서만 얻는다.
import { taskTypeOf, trialTaskTypes, type Clock, type Db } from '@aot/domain';

import { transitionTask } from './transitions.ts';

export interface RoutedTask {
  taskId: string;
  role: string;
  taskType: string;
}

export function routeUnassignedTasks(tx: Db, clock: Clock): RoutedTask[] {
  const roles = tx.all<{ id: string; slug: string; version: number; org_unit_id: string; trial_scope: string | null }>(
    "SELECT id, slug, version, org_unit_id, trial_scope FROM role WHERE lifecycle IN ('trial', 'active') AND trial_scope IS NOT NULL ORDER BY slug",
  );
  if (roles.length === 0) return [];
  const now = clock.nowIso();
  const routed: RoutedTask[] = [];
  const tasks = tx.all<{ id: string; trigger_kind: string; trigger_ref: string; spec: string }>(
    "SELECT id, trigger_kind, trigger_ref, spec FROM task WHERE status = 'unassigned' ORDER BY created_at, id",
  );
  for (const task of tasks) {
    const type = taskTypeOf({ kind: task.trigger_kind, ref: task.trigger_ref });
    const role = roles.find((candidate) => trialTaskTypes(candidate.trial_scope).includes(type));
    if (!role) continue;
    const spec = JSON.parse(task.spec) as Record<string, unknown>;
    const versions = typeof spec['versions'] === 'object' && spec['versions'] !== null ? { ...(spec['versions'] as object), role_version: Number(role.version) } : spec['versions'];
    transitionTask(tx, {
      taskId: task.id, from: 'unassigned', to: 'queued', by: 'scheduler', now, causedBy: 'system:org-routing',
      reason: `assigned to role '${role.slug}' by task type '${type}' (organization trial/active scope)`,
      set: { role_id: role.id, role_version: Number(role.version), org_unit_id: role.org_unit_id, spec: JSON.stringify({ ...spec, role: role.slug, versions }) },
    });
    routed.push({ taskId: task.id, role: role.slug, taskType: type });
  }
  return routed;
}
