// 항상 사람이 정하는 결정의 분류 (ADR-0016 Decision 5). 코드 상수이며 정책으로 바꾸지 못한다.
// 위임 결정의 모든 진입점(delegateDecide, releaseDelegated, 승인 계산이 위임 행을 세는 길, 위임 파싱)은 이 분류를 조회하고,
// 항상 사람이거나 분류할 수 없는 대상이면 거부한다 (fail closed). 이 파일은 다른 정책 모듈을 가져오지 않는다 (document.ts 도 쓴다).

export const ALWAYS_HUMAN = [
  'policy_deploy',         // 정책 배포(위임 변경 포함)
  'org_proposal',          // 조직 변경 제안 전부와 시험 확정
  'strategy_version',      // 실험 전략 승인·승격
  'product_decision',      // 상품 등록 결정
  'effect_resolution',     // 효과 확정(resolve-effect)
  'publication',           // 게시
  'scope_approval_task',   // 초안이 아닌 범위 승인 업무(전화·customer 읽기 등)
  'delete_impact',         // 영향에 delete 가 있는 업무
  'external_input_draft',  // 외부 입력이 쓴 초안
  'human_decided_task',    // 사람이 한 번 결정한 업무
  'delegation_resume',     // 위임 정지 해제
] as const;
export type AlwaysHuman = (typeof ALWAYS_HUMAN)[number];

/** 분류할 수 없는 대상. 항상 사람으로 다룬다 */
export const UNCLASSIFIED = 'unclassified' as const;
export type HumanOnly = AlwaysHuman | typeof UNCLASSIFIED;

/** v1 에서 위임할 수 있는 승인 대상 */
export const DELEGABLE_SUBJECTS = ['task'] as const;

/** 승인 대상 종류(approval.subject_kind 등) → 항상 사람 분류. null 은 "이 종류 자체로는 사람 전용이 아님" (업무는 내용을 더 봐야 한다) */
const BY_KIND: Readonly<Record<string, AlwaysHuman | null>> = {
  task: null,
  policy_version: 'policy_deploy',
  org_proposal: 'org_proposal',
  strategy_version: 'strategy_version',
  publication: 'publication',
  product: 'product_decision',
  effect: 'effect_resolution',
  delegation: 'delegation_resume',
};

/**
 * 결정 대상 하나를 분류한다. 항상 사람이면 그 분류, 위임 대상 종류(task)면 null, 그 밖(모르는 종류·잘못된 값)은 UNCLASSIFIED.
 * `ALWAYS_HUMAN` 의 이름 자체를 넘겨도 된다.
 */
export function humanOnlyKind(subject: unknown): HumanOnly | null {
  if (typeof subject !== 'string') return UNCLASSIFIED;
  if ((ALWAYS_HUMAN as readonly string[]).includes(subject)) return subject as AlwaysHuman;
  if (!Object.hasOwn(BY_KIND, subject)) return UNCLASSIFIED;
  return BY_KIND[subject]!;
}
