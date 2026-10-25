import type { Db, Issue } from '@aot/domain';

import type { DeclarationError } from './idempotency.ts';

/** 업무 생성 거부 (명세 검증, 참조, 의존 순환, 정책 판정). `issues` 에 이유가 모두 담긴다. */
export class TaskCreationError extends Error {
  readonly issues: readonly Issue[];
  /** 정책 거부 판정의 기록 (생성 트랜잭션이 되돌려진 뒤 새 트랜잭션에서 남긴다) */
  readonly recordRefusal: ((tx: Db) => void) | undefined;

  constructor(issues: readonly Issue[], recordRefusal?: (tx: Db) => void) {
    super(`task creation rejected: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`);
    this.name = 'TaskCreationError';
    this.issues = issues;
    this.recordRefusal = recordRefusal;
  }
}

/**
 * 외부 부작용 직전 재검증(정책 게이트)이 전송을 거부했다. 보내지 않았고, run 은 `killed` 로 닫혔으며
 * 업무는 running → needs_review 로 갔다 (state-machines.md "실행 중 재검증에서 정책 거부/승인 범위 이탈").
 */
export class EffectRefusedError extends Error {
  readonly effectId: string;
  readonly reason: string;

  constructor(effectId: string, reason: string) {
    super(`external effect ${effectId} refused by the policy gate: ${reason}`);
    this.name = 'EffectRefusedError';
    this.effectId = effectId;
    this.reason = reason;
  }
}

/** 도구의 (도구, action) 멱등 선언이 없거나 잘못됐다. 보내지 않았고 행도 만들지 않았다 (시작 시 검증이면 데몬이 뜨지 않는다) */
export class EffectDeclarationError extends Error {
  readonly tool: string;
  readonly errors: readonly DeclarationError[];

  constructor(tool: string, errors: readonly DeclarationError[]) {
    super(`effect tool '${tool}' declaration invalid: ${errors.map((e) => `${e.action ?? '(tool)'}: ${e.code}`).join('; ')}`);
    this.name = 'EffectDeclarationError';
    this.tool = tool;
    this.errors = errors;
  }
}

/**
 * lease 펜싱 실패. 이 run 의 소유권을 잃었으므로(만료, 인수, 종료) 호출자는 어떤 쓰기도 더 하지 말고
 * 부작용을 보내지 말고 즉시 멈춰야 한다 (docs/operations/recovery.md §2 규칙 2).
 */
export class LeaseLostError extends Error {
  readonly runId: string;

  constructor(runId: string, what: string) {
    super(`lease lost for run ${runId}: ${what} refused`);
    this.name = 'LeaseLostError';
    this.runId = runId;
  }
}

/** 상태가 기대와 달라 비교 후 갱신(compare-and-set)이 0건이었다. 다른 쓰기가 먼저 일어났다. */
export class StaleStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleStateError';
  }
}

/** 실행 관리가 run 을 강제로 끝냈다(시간 제한 초과, 예산 초과). 실행기가 던지면 워커가 run 을 `killed` 로 닫는다 */
export class RunKilledError extends Error {
  readonly reason: 'time_limit' | 'budget_exceeded';
  readonly detail: string;

  constructor(reason: 'time_limit' | 'budget_exceeded', detail: string) {
    super(`run killed (${reason}): ${detail}`);
    this.name = 'RunKilledError';
    this.reason = reason;
    this.detail = detail;
  }
}

/** 측정 값 입력 거부 (A6-U13, measurement.ts). `code` 는 사유 코드, 메시지는 사람이 읽는 설명이다 */
export class MeasurementRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`measurement refused (${code}): ${message}`);
    this.name = 'MeasurementRefusedError';
    this.code = code;
  }
}
