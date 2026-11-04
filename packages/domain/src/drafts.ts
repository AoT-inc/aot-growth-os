// 외부 부작용 초안(effect_draft, ADR-0015)의 도메인 도우미. 승인 대상 해시에 들어갈 항목, 전이, 메시지 모양 미리보기를 둔다.
// 초안 행은 호스트(task-engine 의 원장 입구, 검증기, 승인 엔진)만 쓴다. 에이전트는 어떤 전이도 일으키지 못한다.
import { assertTransition, type TransitionActor } from './state/machine.ts';
import { EFFECT_DRAFT_MACHINE } from './state/machines.ts';
import type { Db } from './db/types.ts';
import type { EffectDraftState } from './entities/enums.ts';
import type { EffectDraftRow } from './entities/rows.ts';

/** 호스트 전송 run 의 `task_run.adapter` 값. 이 이름은 권한이 아니다: 전송기는 `proposed` 초안만 보내고 `beforeEffect` 가 다시 막는다. */
export const HOST_DISPATCH_ADAPTER = 'host:dispatch';

/** 한 run 이 남길 수 있는 초안 수와 초안 하나의 payload 상한(바이트) */
export const DRAFT_LIMITS = { perRun: 20, payloadBytes: 256 * 1024 } as const;

/** 업무의 `proposed` 초안을 `seq` 순으로. 한 업무에 `proposed` 는 한 run 의 것만 있다(새 초안 run 이 시작되면 이전 것은 superseded). */
export function proposedDraftsOf(db: Db, taskId: string): EffectDraftRow[] {
  return db.all<EffectDraftRow>(
    "SELECT * FROM effect_draft WHERE task_id = ? AND state = 'proposed' ORDER BY task_run_id, seq", [taskId],
  );
}

export interface DraftSubjectEntry {
  draft_id: string;
  seq: number;
  tool: string;
  action: string;
  target: string;
  step_id: string;
  payload_hash: string;
  expires_at: string;
}

/** 승인 대상 해시에 들어가는 초안 항목(본문은 `payload_hash` 로 묶인다). seq 순으로 정렬한다. */
export function draftSubjectEntries(rows: readonly EffectDraftRow[]): DraftSubjectEntry[] {
  return [...rows]
    .sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => ({
      draft_id: row.id, seq: row.seq, tool: row.tool, action: row.action, target: row.target, step_id: row.step_id,
      payload_hash: row.payload_hash, expires_at: row.expires_at,
    }));
}

export interface DraftTransitionRequest {
  taskId: string;
  from: readonly EffectDraftState[];
  to: EffectDraftState;
  by: TransitionActor;
  now: string;
  /** 주면 그 run 의 초안만 바꾼다 */
  runId?: string;
}

/** 초안 상태 전이. 상태표를 확인한 뒤 일괄 UPDATE 하고 바뀐 행 수를 돌려준다. 쓰기 트랜잭션 안에서만 부른다. */
export function transitionDrafts(tx: Db, request: DraftTransitionRequest): number {
  if (request.from.length === 0) return 0;
  for (const from of request.from) assertTransition(EFFECT_DRAFT_MACHINE, { from, to: request.to, by: request.by });
  const marks = request.from.map(() => '?').join(', ');
  const params: (string | number)[] = [request.to, request.now, request.taskId, ...request.from];
  let sql = `UPDATE effect_draft SET state = ?, at = ? WHERE task_id = ? AND state IN (${marks})`;
  if (request.runId !== undefined) {
    sql += ' AND task_run_id = ?';
    params.push(request.runId);
  }
  return tx.run(sql, params).changes;
}

export interface MessagePreview {
  /** to + cc + bcc 순서대로(중복 제거 없음) */
  recipients: string[];
  subject: string | null;
  /** 본문의 비어 있지 않은 첫 줄(앞뒤 공백 제거). 없으면 null */
  firstLine: string | null;
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** payload 가 `{to: string[], cc?, bcc?, subject: string, text: string}` 모양일 때만 미리보기를 돌려준다. 아니면 null. */
export function messagePreviewOf(payload: unknown): MessagePreview | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (!isStringArray(record.to) || typeof record.subject !== 'string' || typeof record.text !== 'string') return null;
  for (const key of ['cc', 'bcc']) {
    if (record[key] !== undefined && !isStringArray(record[key])) return null;
  }
  const recipients = [...record.to, ...((record.cc as string[] | undefined) ?? []), ...((record.bcc as string[] | undefined) ?? [])];
  const subject = record.subject.trim() === '' ? null : record.subject;
  const firstLine = record.text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? null;
  return { recipients, subject, firstLine };
}
