// 실험 결과 검토 채널 (A6-U16): 사람 승인 채널(Unix 소켓, trust-boundaries §3.1)에 얹은 `promote`·`reviews` 명령과, `experiment` 상태 전략의 `reject`.
// 소켓 처리기 조합(assemble.ts)이 이 요청만 여기로 보내고 나머지는 승인 엔진(`engine.handle`)이나 측정 채널로 보낸다 (measure.ts 와 같은 패턴).
//
// 인증 경계: 승인 CLI 와 같다 — 소켓 파일 권한(0700 디렉터리 + 0600 소켓)과 요청 actor 의 `actor.kind='human'` 확인(여기서 한 번, domain 의 전이 함수가 한 번 더).
// TOTP 재인증은 요구하지 않는다: 실험은 사람 1인 승인으로 시작했고(A6 결정 ③) 승격·거절은 외부 부작용이 아니라 전략 상태 기록이다. 에이전트는 소켓이 보이지 않는다(Q26).
//
// 요청 (한 줄 JSON):
//   {cmd:'promote', actor, kind:'strategy_version', id, comment}   experiment → active. 기록된 결과가 pass 일 때만, 이전 active 는 retired(롤백 지점). 사유(comment) 필수
//   {cmd:'reject',  actor, kind:'strategy_version', id, comment}   experiment → rejected. `proposed` 전략의 reject 는 승인 엔진이 처리한다. 사유(comment) 필수
//   {cmd:'reviews', actor}                                         결과 검토 현황: 결과 대기, 승격 대기(pass), 사람 검토 필요(inconclusive 등) + 비교 단계의 검토 대기
// 승격·거절은 한 트랜잭션에서 전이 + 결정 기록(event `experiment-decision:<id>`, 사유 포함) + 실험 종료(루틴 끄기, 멱등)를 묶는다.
import type { Clock, Db } from '@aot/domain';
import { listStrategyReviews, promoteExperiment, rejectExperiment, StrategyRuleError, TransitionError } from '@aot/domain';
import { endExperimentInTx, ExperimentActivationError } from '@aot/task-engine';

import { listExperimentReviews } from './cycle.ts';

export interface ExperimentDecisionOptions {
  db: Db;
  clock: Clock;
}

const KEYS = ['cmd', 'actor', 'kind', 'id', 'comment'];

class Refused extends Error {}

const refuse = (message: string): never => {
  throw new Refused(message);
};

/** 이 요청이 실험 결과 채널의 것인가: `promote`, `reviews`, 그리고 `experiment` 상태 전략의 `reject` */
export function isExperimentDecisionCommand(db: Db, request: unknown): boolean {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return false;
  const body = request as Record<string, unknown>;
  if (body['cmd'] === 'promote' || body['cmd'] === 'reviews') return true;
  if (body['cmd'] !== 'reject' || body['kind'] !== 'strategy_version' || typeof body['id'] !== 'string') return false;
  return db.get<{ status: string }>('SELECT status FROM strategy_version WHERE id = ?', [body['id']])?.status === 'experiment';
}

function requireHuman(db: Db, actorId: unknown): string {
  if (typeof actorId !== 'string' || actorId === '') refuse('an actor id is required');
  const actor = db.get<{ kind: string }>('SELECT kind FROM actor WHERE id = ?', [actorId as string]);
  if (!actor) refuse(`unknown actor '${String(actorId)}'`);
  if (actor!.kind !== 'human') refuse(`only human actors can decide an experiment; '${String(actorId)}' is '${actor!.kind}'`);
  return actorId as string;
}

export function createExperimentDecisionHandler(options: ExperimentDecisionOptions): (request: unknown) => Record<string, unknown> {
  const { db, clock } = options;
  return (raw) => {
    try {
      const request = raw as Record<string, unknown>;
      const actor = requireHuman(db, request['actor']);
      const unknown = Object.keys(request).filter((key) => !KEYS.includes(key));
      if (unknown.length > 0) refuse(`unknown field(s): ${unknown.join(', ')}`);
      if (request['cmd'] === 'reviews') return { ok: true, ...listExperimentReviews(db), comparison_reviews: listStrategyReviews(db) };
      if (request['kind'] !== 'strategy_version') refuse("kind must be 'strategy_version'");
      const id = typeof request['id'] === 'string' && request['id'] !== '' ? request['id'] : refuse('an id is required');
      const reason = typeof request['comment'] === 'string' && request['comment'].trim() !== '' ? request['comment'].trim() : refuse('a reason (--comment) is required');
      if (request['cmd'] === 'promote') {
        const result = db.writeTx((tx) => {
          const promoted = promoteExperiment(tx, clock, { strategyVersionId: id, actorId: actor, reason });
          endExperimentInTx(tx, clock, { strategyVersionId: id, by: 'human', reason: `promoted: ${reason}` });
          return promoted;
        });
        return { ok: true, strategy_version_id: id, status: result.strategy.status, retired: result.retired };
      }
      if (request['cmd'] === 'reject') {
        const row = db.writeTx((tx) => {
          const rejected = rejectExperiment(tx, clock, { strategyVersionId: id, by: 'human', actorId: actor, reason });
          endExperimentInTx(tx, clock, { strategyVersionId: id, by: 'human', reason: `rejected: ${reason}` });
          return rejected;
        });
        return { ok: true, strategy_version_id: id, status: row.status };
      }
      return refuse(`unknown command '${String(request['cmd'])}'`);
    } catch (error) {
      if (error instanceof Refused) return { ok: false, error: error.message };
      if (error instanceof StrategyRuleError) return { ok: false, error: error.message, code: error.code };
      if (error instanceof TransitionError) return { ok: false, error: error.message, code: error.code };
      if (error instanceof ExperimentActivationError) return { ok: false, error: error.message, code: error.code };
      throw error;
    }
  };
}
