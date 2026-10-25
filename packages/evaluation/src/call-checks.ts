// 통화 증거 검사 (ADR-0014 §7). 전화 업무가 "통화를 했다"는 에이전트의 말이 아니라 통화 기록(call), 발화 기록(transcript), 구조화된 결과(outcome)라는
// 원본 증거로 완료되도록 한다. 에이전트는 통화 상태도 결과도 쓸 수 없으므로(domain 이 거부) 이 셋은 자기 보고가 아니다.
// 어느 통화가 기준인가: 업무의 통화 중 `connected` 를 거쳐 `completed` 된 가장 최근 것. 통화는 run 을 넘어 업무에 속한다.
//  - call_completed         : 그런 통화가 있다. 통화가 하나도 없거나 모두 연결 없이 끝났으면 fail, 아직 열린 통화만 있으면 unknown
//  - call_transcript_present: 기준 통화의 transcript 에 발화가 하나 이상 있다
//  - call_outcome_recorded  : 기준 통화의 outcome 이 있고, 명세 `expected_call_outcome` 의 허용 disposition 과 필수 필드를 만족한다.
//                             없거나 기준에 못 미치면 unknown(증거 부족 → 사람 검토): 결과 추출이 부족하다고 업무를 재시도해 다시 전화하지 않는다
import { getCallOutcome, getTranscript, listCallsForTask, missingOutcomeFields, type Call, type Db, type EvidenceRow, type TaskSpec } from '@aot/domain';

// checks.ts 가 이 모듈의 함수를 부르므로(순환 금지) 검사 결과의 모양은 여기서 구조적으로 다시 적는다. checks.ts 의 CheckOutcome 과 같다.
export interface CallCheckOutcome {
  status: 'pass' | 'fail' | 'unknown';
  note: string;
  evidence?: ReadonlyMap<string, { verified: boolean; note: string }>;
}
type EvidenceContribution = { verified: boolean; note: string };

/** 통화 검사가 읽는 것: 업무, 명세, 업무에 연결된 evidence 행 */
export interface CallCheckInput {
  db: Db;
  taskId: string;
  spec: TaskSpec;
  evidence: readonly EvidenceRow[];
}

export const CALL_COMPLETED_CHECK_ID = 'call_completed';
export const CALL_TRANSCRIPT_CHECK_ID = 'call_transcript_present';
export const CALL_OUTCOME_CHECK_ID = 'call_outcome_recorded';

/** 연결된 뒤 정상 종료된 통화 중 가장 최근 것 */
export function qualifyingCall(db: Db, taskId: string): Call | null {
  const calls = listCallsForTask(db, taskId).filter((call) => call.status === 'completed' && call.connectedAt !== null);
  return calls.at(-1) ?? null;
}

const evidenceFor = (input: CallCheckInput, ref: string, contribution: EvidenceContribution): Map<string, EvidenceContribution> => {
  const row = input.evidence.find((candidate) => candidate.ref === ref);
  return row ? new Map([[row.id, contribution]]) : new Map();
};

export function checkCallCompleted(input: CallCheckInput): CallCheckOutcome {
  const calls = listCallsForTask(input.db, input.taskId);
  if (calls.length === 0) return { status: 'fail', note: 'no call was placed or linked for this task (an agent report of a conversation is not evidence)' };
  const call = qualifyingCall(input.db, input.taskId);
  if (call) {
    return { status: 'pass', note: `call ${call.id} connected at ${call.connectedAt} and completed at ${call.endedAt}`, evidence: evidenceFor(input, `call:${call.id}`, { verified: true, note: 'call connected and completed' }) };
  }
  const open = calls.filter((c) => c.status !== 'completed' && c.status !== 'failed' && c.status !== 'cancelled');
  if (open.length > 0) return { status: 'unknown', note: `${open.length} call(s) have not ended yet (${open.map((c) => c.status).join(', ')})` };
  const evidence = new Map<string, EvidenceContribution>();
  for (const c of calls) for (const [id, contribution] of evidenceFor(input, `call:${c.id}`, { verified: false, note: `call ended as ${c.status} without a conversation` })) evidence.set(id, contribution);
  return { status: 'fail', note: `no call connected and completed: ${calls.map((c) => `${c.status}${c.endReason ? ` (${c.endReason})` : ''}`).join(', ')}`, evidence };
}

export function checkCallTranscript(input: CallCheckInput): CallCheckOutcome {
  const call = qualifyingCall(input.db, input.taskId);
  if (!call) return { status: 'unknown', note: 'there is no completed call whose transcript could be checked' };
  const transcript = getTranscript(input.db, call.id);
  if (!transcript || transcript.turns.length === 0) {
    return { status: 'fail', note: `call ${call.id} has no transcript`, evidence: evidenceFor(input, `call:${call.id}#transcript`, { verified: false, note: 'empty transcript' }) };
  }
  return { status: 'pass', note: `call ${call.id} transcript has ${transcript.turns.length} turn(s)`, evidence: evidenceFor(input, `call:${call.id}#transcript`, { verified: true, note: 'transcript present' }) };
}

function outcomeProblems(db: Db, callId: string, expected: TaskSpec['expected_call_outcome']): { problems: string[]; present: boolean } {
  const outcome = getCallOutcome(db, callId);
  if (!outcome) return { problems: ['no structured outcome was recorded for the call (a free-text summary is not an outcome)'], present: false };
  const problems: string[] = [];
  if (expected !== undefined) {
    if (!expected.dispositions.includes(outcome.disposition)) problems.push(`disposition '${outcome.disposition}' is not one of: ${expected.dispositions.join(', ')}`);
    const missing = missingOutcomeFields(outcome, expected.required_fields ?? []);
    if (missing.length > 0) problems.push(`required field(s) missing: ${missing.join(', ')}`);
  }
  return { problems, present: true };
}

export function checkCallOutcome(input: CallCheckInput): CallCheckOutcome {
  const call = qualifyingCall(input.db, input.taskId);
  if (!call) return { status: 'unknown', note: 'there is no completed call whose outcome could be checked' };
  const { problems, present } = outcomeProblems(input.db, call.id, input.spec.expected_call_outcome);
  const evidence = present ? evidenceFor(input, `call:${call.id}#outcome`, { verified: problems.length === 0, note: problems.length === 0 ? 'outcome meets the task requirements' : problems.join('; ') }) : new Map<string, EvidenceContribution>();
  return problems.length === 0
    ? { status: 'pass', note: `call ${call.id} has an outcome that meets the task requirements`, evidence }
    : { status: 'unknown', note: problems.join('; '), evidence };
}
