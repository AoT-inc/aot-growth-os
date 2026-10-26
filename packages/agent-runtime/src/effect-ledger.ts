// 부작용 원장에 묶인 도구 실행기 (ADR-0014 §8, ADR-0005 Amendment). 도구 게이트웨이는 호출별 정책 판정이 `require_approval` 일 때 호출을 막는다(게이트웨이에는 승인 경로가 없다).
// 단 하나의 예외가 이 모듈로 만든 실행기다: 부작용을 부작용 원장(`performEffect`)으로만 보내는 실행기는 원장이 전송 직전마다 정책과 *사람의 업무 승인*을
// 다시 확인하므로(`TaskPolicyGate.beforeEffect`), 게이트웨이가 승인 판정을 원장에 넘겨도 승인 없이 전송되지 않는다.
//
// 이 예외를 설정값(불리언)이 아니라 *구조*로 만든 이유: 스펙에 붙은 표시는 누구든 켤 수 있어 승인 우회 수단이 된다. 여기서는
//  1. 표시가 실행기 함수 자체에 붙고, 이 모듈의 비공개 WeakSet 에만 등록된다. 스펙·설정·JSON 으로는 만들 수 없고, 다른 곳에서 같은 모양의 객체를 만들어도 인정되지 않는다.
//  2. 실행기 본문은 `perform`(원장 호출)을 인자로 받는다. 부작용을 보낼 수 있는 길로 주어지는 것은 이것이며, 본문이 `perform` 도 `perform.noEffect(이유)` 도 부르지 않고 끝나면
//     (원장을 거치지 않고 부작용을 보냈을 수 있다) 호출은 성공이 아니라 오류로 처리된다.
//  3. 게이트웨이는 이런 실행기를 부작용 도구(`sideEffect=true`, 영향 `external_effect`)에만 받는다. 그 밖의 설정은 시작 때 거부한다.
// 한계: 본문이 `perform` 없이 직접 외부에 접근하는 것까지 막지는 못한다. 실행기는 호스트가 조립하는 신뢰된 코드이고(에이전트는 닿지 못한다) 이 구조는 실수와 설정 오류를 잡는다.
// 이 모듈은 게이트웨이 타입을 참조하지 않는다(순환 방지): 요청·결과 타입은 제네릭이다.

/** 원장을 거쳐 부작용을 보내는 함수 (task-engine 의 `RunContext.performEffect` 와 구조가 같다) */
export type EffectLedgerRunner<Step, Outcome> = (tool: string, step: Step) => Promise<Outcome>;

export interface LedgerPerform<Step, Outcome> {
  (tool: string, step: Step): Promise<Outcome>;
  /** 이 호출은 외부 부작용을 일으키지 않았다고 명시한다(예: provider 에 닿지 않은 통화의 로컬 취소). 이유는 호출 기록에 남기지 않지만 호출 지점에서 읽을 수 있게 필수다 */
  noEffect(reason: string): void;
}

const BOUND = new WeakSet<object>();

export function bindToEffectLedger<Req, Res, Step, Outcome>(options: {
  ledger: EffectLedgerRunner<Step, Outcome>;
  run: (request: Req, perform: LedgerPerform<Step, Outcome>) => Promise<Res>;
}): (request: Req) => Promise<Res> {
  const executor = async (request: Req): Promise<Res> => {
    let passed = 0;
    const perform = Object.assign(
      (tool: string, step: Step): Promise<Outcome> => {
        passed += 1;
        return options.ledger(tool, step);
      },
      {
        noEffect: (reason: string): void => {
          if (typeof reason !== 'string' || reason.trim() === '') throw new Error('noEffect needs a reason');
          passed += 1;
        },
      },
    );
    const result = await options.run(request, perform);
    if (passed === 0) throw new Error('a ledger-bound tool finished without passing the effect ledger (neither perform nor noEffect was called)');
    return result;
  };
  BOUND.add(executor);
  return executor;
}

/** 이 실행기가 `bindToEffectLedger` 로 만든 것인가 */
export const isEffectLedgerBound = (executor: unknown): boolean => typeof executor === 'function' && BOUND.has(executor);
