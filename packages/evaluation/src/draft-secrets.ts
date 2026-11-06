// 외부 부작용 초안(effect_draft) payload 의 비밀 검사 (ADR-0015). 초안 승인은 사람이 *모든 바이트를 보고* 하는 승인이어야 하는데, 표시(CLI·검토 화면)는 비밀로 보이는 값을
// 가린다. 그래서 비밀 모양(값)이나 비밀 이름(키)이 있는 초안은 사람에게 가기 전에 안전성 실패로 막는다. 명세의 `validation.deterministic` 에 적혔는지와 무관하게 항상 돈다(evaluator.ts).
// 키 이름 규칙은 agent-runtime/src/mask.ts 의 `isSecretKey` 와 같아야 한다(시험이 같은 표본으로 대조한다: evaluation-secret-patterns.test.ts).
import { isSecretKeyName, type Db } from '@aot/domain';

import { findSecretShapes } from './secret-patterns.ts';

export const DRAFT_SECRET_CHECK_ID = 'draft_secret_scan';

function secretKeyPaths(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => secretKeyPaths(child, `${path}[${index}]`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const here = path === '' ? key : `${path}.${key}`;
      if (isSecretKeyName(key)) out.push(here);
      else secretKeyPaths(child, here, out);
    }
  }
}

/** 한 payload(JSON 문자열)의 발견 사항. 종류·개수·키 경로만 담고 값은 담지 않는다 */
export function draftPayloadFindings(payload: string): string[] {
  const findings: string[] = findSecretShapes(payload).map((shape) => `${shape.kind} x${shape.count}`);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(payload);
  } catch {
    findings.push('payload is not JSON');
  }
  const keys: string[] = [];
  secretKeyPaths(parsed, '', keys);
  for (const path of keys) findings.push(`secret-named key '${path}'`);
  return findings;
}

/** 이 run 이 남긴 모든 초안(상태 무관)의 발견 사항: `draft <id>: …` 목록. 비면 깨끗하다 */
export function draftSecretFindings(db: Db, runId: string): string[] {
  const drafts = db.all<{ id: string; payload: string }>('SELECT id, payload FROM effect_draft WHERE task_run_id = ? ORDER BY seq', [runId]);
  const out: string[] = [];
  for (const draft of drafts) {
    const found = draftPayloadFindings(draft.payload);
    if (found.length > 0) out.push(`draft ${draft.id}: ${found.join(', ')}`);
  }
  return out;
}
