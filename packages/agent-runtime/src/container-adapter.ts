// 컨테이너 러너(U3)를 어댑터 계약(`AgentAdapter`)으로 감싼다. 실행 관리(run-manager.ts)는 어댑터와 러너를 같은 모양으로 다룬다.
// 시간 제한은 실행 관리가 건다(주입 타이머 → abort → 러너가 `docker kill`). 러너 자체의 `timeLimitMs` 는 쓰지 않아 제한이 이중으로 걸리지 않는다.
import type { AdapterContext, AdapterInput, AdapterOutput, AgentAdapter } from './contract.ts';
import type { ContainerRunner } from './container-runner.ts';

export function containerAgentAdapter(runner: ContainerRunner): AgentAdapter {
  return {
    name: runner.name,
    async run(input: AdapterInput, context: AdapterContext): Promise<AdapterOutput> {
      return (await runner.run(input, context)).output;
    },
  };
}
