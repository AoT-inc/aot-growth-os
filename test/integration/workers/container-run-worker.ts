// 자식 프로세스: 컨테이너 러너로 적대적 에이전트(stdin EOF 무시)를 실행한다. 부모가 이 프로세스를 SIGKILL 하면 데몬이 비정상 종료된 상황이 된다:
// `docker run` CLI 만 남고 컨테이너는 계속 돈다 (스파이크 Q26 §3). 부모는 라벨로 고아 정리가 되는지 본다.
//
// 인자: <docker 절대 경로> <이미지 ID> <run id> <인스턴스 라벨 (부모의 TEST_INSTANCE)>
// 자식 → 부모: {type:'tool-called'} (컨테이너 안 에이전트가 첫 도구 호출을 보냈다 = 컨테이너가 돌고 있다)
import { systemClock } from '@aot/domain';
import { createContainerRunner, createDockerCli, pickDockerEnv } from '@aot/agent-runtime';

import { contractInput } from '../../support/adapter-contract.ts';

const [dockerPath, image, runId, instance] = process.argv.slice(2);
const docker = createDockerCli({ path: dockerPath!, env: pickDockerEnv(process.env) });
const runner = createContainerRunner({
  docker, image: image!, instance: instance!, namePrefix: 'aot-test', clock: systemClock, agentArgs: ['hostile'],
  limits: { memoryMiB: 128, cpus: 0.5, pidsLimit: 32, tmpfsMiB: 16 },
});
const controller = new AbortController();
void runner.run({ ...contractInput(), run_id: runId! }, {
  gateway: { call: () => { process.send?.({ type: 'tool-called' }); return Promise.resolve({ ok: true, result: { text: 'before-hang' } }); } },
  signal: controller.signal,
  onCostProgress: () => undefined,
});
