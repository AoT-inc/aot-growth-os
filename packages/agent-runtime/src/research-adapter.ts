// 읽기 전용 조사 에이전트의 호스트 쪽 어댑터 (단계 A5 U5): 조사 에이전트 이미지(container/research-agent)를 컨테이너 러너(U3)로 띄우는 `AgentAdapter` 다.
// 이미지는 데몬 설정의 이미지 ID(`sha256:…`)로만 실행한다. 에이전트가 쓰는 도구는 게이트웨이의 `fetch_url`(fetch-url.ts) 하나이며,
// 어댑터가 하는 일은 `containerAgentAdapter(createContainerRunner(…))` 뿐이다(정책 판단 없음, 시간 제한·예산 강제는 실행 관리 몫).
import type { Clock } from '@aot/domain';

import { containerAgentAdapter } from './container-adapter.ts';
import type { ContainerLimits } from './container-args.ts';
import { createContainerRunner } from './container-runner.ts';
import type { AgentAdapter } from './contract.ts';
import type { DockerCli } from './docker.ts';
import type { GatewayTimers } from './gateway.ts';

/** `task_run.adapter` 에 기록되는 이름 */
export const RESEARCH_AGENT_NAME = 'research-agent';
/** 조사 에이전트에 충분한 자원 상한 (작은 Node 프로세스: 모델·로컬 파일 없음) */
export const RESEARCH_AGENT_LIMITS: Readonly<ContainerLimits> = { memoryMiB: 128, cpus: 0.5, pidsLimit: 32, tmpfsMiB: 16 };

export interface ResearchAgentAdapterOptions {
  docker: DockerCli;
  /** 조사 에이전트 이미지 ID `sha256:…` (container/research-agent/Dockerfile 의 빌드 결과) */
  image: string;
  /** `aot.instance` 라벨 값(데몬 인스턴스 ID) */
  instance: string;
  clock: Clock;
  limits?: ContainerLimits;
  /** 컨테이너 이름 접두사. 기본 'aot-research' */
  namePrefix?: string;
  timers?: GatewayTimers;
}

export function createResearchAgentAdapter(options: ResearchAgentAdapterOptions): AgentAdapter {
  return containerAgentAdapter(createContainerRunner({
    docker: options.docker,
    image: options.image,
    instance: options.instance,
    limits: options.limits ?? { ...RESEARCH_AGENT_LIMITS },
    clock: options.clock,
    name: RESEARCH_AGENT_NAME,
    namePrefix: options.namePrefix ?? 'aot-research',
    ...(options.timers === undefined ? {} : { timers: options.timers }),
  }));
}
