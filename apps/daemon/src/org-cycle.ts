// 조직 주기 처리 (Phase B / B5, ADR-0011). 데몬 tick 뒤마다 부른다 (설정 없이 항상 켜져 있다: 제안이 없으면 읽기만 하고 아무것도 쓰지 않는다).
// 한 번의 advance 가 하는 일 (제안마다 별도 트랜잭션, 한 제안의 오류가 다른 제안을 막지 않는다):
//  1. 만료(`proposed → expired`)·기준 버전 충돌(`proposed → superseded`) 정리
//  2. 승인된 제안 시작 (`approved → trial`, 시스템): 새 역할·부서·`org_version(trial)` 생성
//  3. 맞는 역할이 없어 `unassigned` 인 업무 중 시험/활성 역할의 범위에 드는 것 배정 (`routeUnassignedTasks`)
//  4. 시험 중인 제안 평가 (`evaluateOrgTrial` → 판정 기록): `fail` → `trial → rolled_back`(평가기), `inconclusive` → `trial → inconclusive`(평가기),
//     `pass` 는 사람 확인(`org confirm`)을 기다린다(자동 승격 없음), `pending` 은 아무것도 쓰지 않는다
// 시각은 주입된 Clock 에서만 얻는다.
import { expireOrgProposals, getOrgProposal, supersedeStaleOrgProposals, transitionOrgProposal, type Clock, type Db } from '@aot/domain';
import { evaluateOrgTrial, recordOrgTrialResult } from '@aot/evaluation';
import { routeUnassignedTasks, type RoutedTask } from '@aot/task-engine';

export interface OrgCycleReport {
  expired: string[];
  superseded: string[];
  started: Array<{ proposalId: string; orgVersionId: string | null }>;
  routed: RoutedTask[];
  evaluated: Array<{ proposalId: string; verdict: string; reason: string; transitionedTo: string | null }>;
  /** 평가 `pass` 라 사람 확인(`org confirm`)을 기다리는 제안 */
  awaitingConfirmation: string[];
  failed: Array<{ proposalId: string | null; error: string }>;
}

export function advanceOrganization(db: Db, clock: Clock): OrgCycleReport {
  const report: OrgCycleReport = { expired: [], superseded: [], started: [], routed: [], evaluated: [], awaitingConfirmation: [], failed: [] };
  const guard = (proposalId: string | null, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      report.failed.push({ proposalId, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const open = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM org_proposal WHERE status IN ('proposed', 'approved', 'trial')")?.n ?? 0;
  const roles = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM role WHERE trial_scope IS NOT NULL AND lifecycle IN ('trial', 'active')")?.n ?? 0;
  if (open === 0 && roles === 0) return report;

  guard(null, () => {
    report.expired = db.writeTx((tx) => expireOrgProposals(tx, clock));
    report.superseded = db.writeTx((tx) => supersedeStaleOrgProposals(tx, clock));
  });
  for (const { id } of db.all<{ id: string }>("SELECT id FROM org_proposal WHERE status = 'approved' ORDER BY created_at, id")) {
    guard(id, () => {
      const result = db.writeTx((tx) => transitionOrgProposal(tx, clock, { proposalId: id, to: 'trial', by: 'system', reason: 'approved; evaluation and rollback plans are complete' }));
      report.started.push({ proposalId: id, orgVersionId: result.orgVersionId });
    });
  }
  guard(null, () => {
    report.routed = db.writeTx((tx) => routeUnassignedTasks(tx, clock));
  });
  for (const { id } of db.all<{ id: string }>("SELECT id FROM org_proposal WHERE status = 'trial' ORDER BY created_at, id")) {
    guard(id, () => {
      const proposal = getOrgProposal(db, id)!;
      const assessment = evaluateOrgTrial(db, clock, proposal);
      let transitionedTo: string | null = null;
      db.writeTx((tx) => {
        recordOrgTrialResult(tx, clock, id, assessment);
        if (assessment.verdict === 'fail') {
          transitionOrgProposal(tx, clock, { proposalId: id, to: 'rolled_back', by: 'evaluator', reason: assessment.reason });
          transitionedTo = 'rolled_back';
        } else if (assessment.verdict === 'inconclusive') {
          transitionOrgProposal(tx, clock, { proposalId: id, to: 'inconclusive', by: 'evaluator', reason: assessment.reason });
          transitionedTo = 'inconclusive';
        }
      });
      if (assessment.verdict === 'pass') report.awaitingConfirmation.push(id);
      if (assessment.verdict !== 'pending') report.evaluated.push({ proposalId: id, verdict: assessment.verdict, reason: assessment.reason, transitionedTo });
    });
  }
  return report;
}
