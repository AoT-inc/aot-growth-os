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

/**
 * 표시용 가리기(`mask`)가 원본에서 바꾼 값의 경로 (`to[0]`, `text`, `headers.authorization`). 원본과 가린 사본을 나란히 걸어 다른 잎(leaf)·가려진 키를 모은다.
 * 사람이 승인하는 초안은 표시에서 한 바이트도 가려지지 않아야 하므로, 비어 있지 않으면 승인할 수 없다 (ADR-0015).
 */
export function maskedPathsOf(original: unknown, masked: unknown, path = ''): string[] {
  if (original === masked) return [];
  if (Array.isArray(original) && Array.isArray(masked) && original.length === masked.length) {
    return original.flatMap((child, index) => maskedPathsOf(child, masked[index], `${path}[${index}]`));
  }
  if (original !== null && masked !== null && typeof original === 'object' && typeof masked === 'object' && !Array.isArray(original) && !Array.isArray(masked)) {
    const a = original as Record<string, unknown>;
    const b = masked as Record<string, unknown>;
    return Object.keys(a).flatMap((key) => maskedPathsOf(a[key], b[key], path === '' ? key : `${path}.${key}`));
  }
  return [path === '' ? '(root)' : path];
}

export const DRAFT_SEND_STATES = ['none', 'planned', 'dispatched', 'confirmed', 'failed', 'unknown', 'compensated'] as const;
export type DraftSendState = (typeof DRAFT_SEND_STATES)[number];

/** 초안의 전송 상태: 같은 effect_key 의 원장 행 상태 (행이 없으면 `none`). 원장이 유일한 근거다 */
export function draftSendStates(db: Db, rows: readonly Pick<EffectDraftRow, 'id' | 'effect_key'>[]): Map<string, DraftSendState> {
  const out = new Map<string, DraftSendState>();
  for (const row of rows) {
    const effect = db.get<{ state: DraftSendState }>('SELECT state FROM external_effect WHERE effect_key = ?', [row.effect_key]);
    out.set(row.id, effect?.state ?? 'none');
  }
  return out;
}

const SECRET_KEY = /(password|passwd|passphrase|secret|apikey|accesskey|privatekey|authorization|cookie|credential|bearer|signature|totp)/;
const SECRET_KEY_SUFFIX = /(token|otp)$/;

/**
 * 키 이름(소문자, 영숫자만 남김)이 비밀을 가리키는가. agent-runtime/src/mask.ts 의 `isSecretKey` 와 같은 규칙이다 — 이 패키지들은 서로 참조할 수 없어 복사본이고,
 * test/unit/evaluation-secret-patterns.test.ts 가 같은 표본으로 대조한다. 초안 검사(evaluation)와 승인 엔진의 기본 가리기(policy)가 쓴다.
 */
export function isSecretKeyName(key: string): boolean {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEY.test(compact) || SECRET_KEY_SUFFIX.test(compact);
}

/** 키 이름만 보는 기본 가리기. 값 모양(Bearer 토큰 등)은 평가기의 초안 검사(안전성 실패)가 막는다. 주입이 없을 때의 기본값이다 */
export function maskSecretKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecretKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, isSecretKeyName(key) ? '[REDACTED]' : maskSecretKeys(child)]));
  }
  return value;
}
