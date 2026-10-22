// 읽기 전용 조사 에이전트 이미지(packages/agent-runtime/container/research-agent)를 빌드하는 시험 도우미. 실제 docker 를 쓴다.
// 빌드 컨텍스트는 packages/agent-runtime 이다(Dockerfile 주석). 같은 내용의 이미지가 이미 있으면 재사용한다. 빌드할 수 없으면(오프라인 등) 이유를 돌려주고 시험은 skip 한다.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildImage, prepareDocker, type SandboxPreparation } from './container-sandbox.ts';

export const AGENT_RUNTIME_DIR = fileURLToPath(new URL('../../packages/agent-runtime/', import.meta.url));
export const RESEARCH_AGENT_DIR = join(AGENT_RUNTIME_DIR, 'container', 'research-agent');

/** 이미지에 들어가는 파일 전부 (Dockerfile 의 COPY 와 같다. 시험 test/unit/research-agent-image.test.ts 가 맞는지 본다) */
export const RESEARCH_AGENT_IMAGE_FILES: readonly string[] = [
  'container/research-agent/Dockerfile', 'container/research-agent/image-package.json', 'container/research-agent/core.ts', 'container/research-agent/agent.ts',
  'src/wire.ts', 'src/line-reader.ts',
];

export async function prepareResearchAgent(): Promise<SandboxPreparation> {
  const ready = await prepareDocker();
  if (!ready.ok) return ready;
  const built = await buildImage(ready.docker, {
    label: 'research-agent',
    dockerfile: join(RESEARCH_AGENT_DIR, 'Dockerfile'),
    context: AGENT_RUNTIME_DIR,
    hashFiles: RESEARCH_AGENT_IMAGE_FILES.map((file) => join(AGENT_RUNTIME_DIR, file)),
  });
  if (!built.ok) return { ok: false, reason: built.reason };
  return { ok: true, env: { docker: ready.docker, dockerVersion: ready.dockerVersion, imageId: built.imageId } };
}
