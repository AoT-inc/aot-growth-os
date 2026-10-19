// 문서에 실린 task_spec 예시를 그대로 꺼내 쓴다 (문서와 검증기가 어긋나면 시험이 깨진다).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './schema-snapshot.ts';

function firstJsonBlock(relativePath: string, afterHeading?: string): unknown {
  const text = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
  const start = afterHeading === undefined ? 0 : text.indexOf(afterHeading);
  if (start < 0) throw new Error(`${relativePath}: heading not found: ${afterHeading}`);
  const match = /```json\n([\s\S]*?)\n```/.exec(text.slice(start));
  if (!match) throw new Error(`${relativePath}: no json block`);
  return JSON.parse(match[1]!);
}

/** docs/schema/task-spec.md 의 "주간 시장 조사" 예시 */
export const marketResearchExample = (): Record<string, unknown> =>
  firstJsonBlock('docs/schema/task-spec.md', '## 예시: 주간 시장 조사') as Record<string, unknown>;

/** workflows/product-registration.md §3 의 업무 명세 템플릿 */
export const productRegistrationTemplate = (): Record<string, unknown> =>
  firstJsonBlock('workflows/product-registration.md', '## 3. 업무 명세 템플릿') as Record<string, unknown>;

/** 시험용 최소 유효 draft. 호출마다 새 객체. */
export function minimalDraft(): Record<string, unknown> {
  return {
    objective: 'example-product 관련 시장 변화를 출처와 함께 정리한다',
    trigger: { kind: 'manual', ref: 'actor:example-owner' },
    inputs: [{ name: 'keywords', ref: 'strategy:active#research_keywords', kind: 'strategy' }],
    allowed_tools: [{ tool: 'web_search', operations: ['search', 'fetch'] }],
    constraints: { time_limit: '30m', network_allowlist: ['search.example.com'], publish_scope: 'internal' },
    acceptance_criteria: ['각 주장에 출처 URL이 1개 이상 있다'],
    validation: { deterministic: ['url_reachable'], llm: null, human: false },
    cost_budget: { max_usd: 2.0 },
  };
}
