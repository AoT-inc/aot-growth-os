// 루틴 템플릿 포트(RoutineTemplateSource)의 가짜 구현. 실제 구현은 apps(팩 로더, A6-U10)가 한다.
import type { RoutineTemplateRequest, RoutineTemplateSource, RoutineTemplateTask } from '@aot/task-engine';

import { minimalDraft } from './spec-fixtures.ts';

/** generalist 가 맡는 업무 명세 초안. 입력 `n` 만 달라도 다른 업무다 */
export function templateSpec(objective: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...minimalDraft(), role: 'generalist', objective, ...extra };
}

/** 수집 → 분석 → 보고. 분석은 수집에, 보고는 분석과 수집에 의존한다. 입력은 셋 다 같다 (dedupe 가 이름으로 갈려야 한다) */
export const threeStepTemplate = (): RoutineTemplateTask[] => [
  { name: 'report', spec: templateSpec('주간 보고를 쓴다'), dependsOn: ['analyze', 'collect'] },
  { name: 'collect', spec: templateSpec('자료를 모은다') },
  { name: 'analyze', spec: templateSpec('자료를 분석한다'), dependsOn: ['collect'] },
];

export interface FakeTemplateSource extends RoutineTemplateSource {
  readonly requests: RoutineTemplateRequest[];
}

/** `routine.task_template` 문자열로 템플릿을 고른다. 모르는 템플릿은 던진다 */
export function fakeTemplateSource(templates: Record<string, () => readonly RoutineTemplateTask[]>): FakeTemplateSource {
  const requests: RoutineTemplateRequest[] = [];
  return {
    requests,
    resolve(request) {
      requests.push(request);
      const template = templates[request.routine.taskTemplate];
      if (!template) throw new Error(`unknown template '${request.routine.taskTemplate}'`);
      return template();
    },
  };
}
