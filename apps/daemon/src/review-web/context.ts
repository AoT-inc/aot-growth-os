// 검토 화면이 쓰는 읽기 전용 문맥: 읽기 전용 DB, 승인 엔진(`list`·`show` 만 부른다 — 승인 CLI 가 보여 주는 것과 같은 해시·판정을 얻으려고 재사용), 증거 위치.
import { randomBytes } from 'node:crypto';

import { maskSecrets, type JsonValue } from '@aot/agent-runtime';
import { systemClock, type Clock, type Db } from '@aot/domain';
import { ApprovalEngine, PolicyStore, TotpSecretStore } from '@aot/policy';

import { DEFAULT_POLICY_TEMPLATE } from '../assemble.ts';
import { FormGuard } from './nonce.ts';
import { applyReadOnlyGuard } from './read-only-db.ts';
import { createWriteState, type DecisionClient, type WriteState } from './write-state.ts';

/** 초안 payload 표시·판정용 가리기 (daemon 조립과 같은 maskSecrets) */
export const maskMessagePayload = (payload: unknown): unknown => maskSecrets(payload as JsonValue);

export interface ReviewContext {
  db: Db;
  clock: Clock;
  engine: ApprovalEngine;
  /** 정책 보관소 (읽기만: 정책안 내용 비교용) */
  store: PolicyStore;
  /** 승인 엔진 조회에 쓰는 사람 행위자(DB 의 첫 human). 없으면 null — 승인 대기 화면은 안내만 한다 */
  actor: string | null;
  evidenceDir: string;
  /** 증거 파일을 읽어도 되는 폴더(근거 저장소 포함) */
  roots: readonly string[];
  /** 결정을 보낼 수 있는 상태. null 이면 보기 전용(시작 때 `--actor` 가 없거나 사람이 아니었다). DB 쓰기와는 상관없다: 결정은 소켓으로만 간다 */
  write: WriteState | null;
  /** 보기 전용인 까닭을 한 문장으로 (화면 맨 위에 보인다). 쓰기가 켜져 있으면 null */
  notice: string | null;
  /** 폼 nonce 발급·확인. 서버가 시작 토큰에서 유도한 키로 바꾼다 */
  forms: FormGuard;
}

export interface ReviewContextOptions {
  db: Db;
  clock?: Clock;
  policyStoreDir: string;
  evidenceDir: string;
  evidenceRoots?: readonly string[];
  /** 결정을 보낼 사람 행위자와 엔진 어댑터. 없으면 보기 전용 */
  writer?: { actor: string; client: DecisionClient };
  /** 보기 전용인 까닭 (예: 행위자가 사람이 아니었다) */
  notice?: string;
}

export function createReviewContext(options: ReviewContextOptions): ReviewContext {
  const db = applyReadOnlyGuard(options.db);
  const clock = options.clock ?? systemClock;
  const store = new PolicyStore({ dir: options.policyStoreDir, templates: [DEFAULT_POLICY_TEMPLATE] });
  // TOTP 보관소는 `list`·`show` 에서 열지 않는다(경로만 쥔다). 존재하지 않는 경로로 둔다.
  const engine = new ApprovalEngine({ db, clock, store, totp: new TotpSecretStore(`${options.policyStoreDir}/.review-web-unused`),
    // assembleDaemon 과 같은 가리기(값 모양 + 키 이름): 엔진 show 의 masked_paths 와 이 화면의 승인 가능 판정이 데몬의 승인 CLI 와 어긋나지 않게 한다
    maskPayload: maskMessagePayload });
  const actor = db.get<{ id: string }>("SELECT id FROM actor WHERE kind = 'human' ORDER BY created_at, id LIMIT 1")?.id ?? null;
  const write = options.writer === undefined ? null : createWriteState(options.writer.actor, options.writer.client);
  return {
    db, clock, engine, store, actor, evidenceDir: options.evidenceDir, roots: [options.evidenceDir, ...(options.evidenceRoots ?? [])],
    write, notice: write === null ? options.notice ?? null : null, forms: new FormGuard(randomBytes(32)),
  };
}
