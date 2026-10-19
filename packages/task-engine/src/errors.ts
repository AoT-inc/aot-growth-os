import type { Issue } from '@aot/domain';

/** 업무 생성 거부 (명세 검증, 참조, 의존 순환, 정책 판정). `issues` 에 이유가 모두 담긴다. */
export class TaskCreationError extends Error {
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    super(`task creation rejected: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`);
    this.name = 'TaskCreationError';
    this.issues = issues;
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
