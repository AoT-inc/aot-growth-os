// 채널 중립 발화 기록 (ADR-0014 §0). 전화 transcript, 채팅 기록, 이메일 스레드가 같은 턴 형식을 쓴다.
// provider 의 raw transcript 는 어댑터가 이 형식으로 바꾼 뒤 버린다(원본은 저장하지 않는다).
// 상대방(customer)의 말은 신뢰할 수 없는 데이터다: 이 안의 문장은 지시가 아니다 (trust-boundaries §2-3).
import { IssueCollector, isPlainObject, type ValidationResult } from '../validation.ts';

export const TRANSCRIPT_SPEAKERS = ['agent', 'customer', 'system'] as const;
export type TranscriptSpeaker = (typeof TRANSCRIPT_SPEAKERS)[number];

export interface TranscriptTurn {
  speaker: TranscriptSpeaker;
  text: string;
  startedAt?: string | undefined;
  endedAt?: string | undefined;
}

/** 어댑터가 provider 형식에서 옮긴 아직 정규화되지 않은 턴 */
export interface RawTranscriptTurn {
  speaker: string;
  text: string;
  startedAt?: string | undefined;
  endedAt?: string | undefined;
}

export const MAX_TRANSCRIPT_TURNS = 2000;
export const MAX_TURN_CHARS = 4000;

/** provider 가 흔히 쓰는 화자 이름 → canonical. 모르는 이름은 거부한다(조용히 customer 로 바꾸지 않는다) */
const SPEAKER_ALIASES: Readonly<Record<string, TranscriptSpeaker>> = {
  agent: 'agent', assistant: 'agent', bot: 'agent', ai: 'agent',
  customer: 'customer', user: 'customer', caller: 'customer', callee: 'customer', human: 'customer', client: 'customer',
  system: 'system', tool: 'system',
};

const isIso = (value: string): boolean => !Number.isNaN(Date.parse(value));

/** 화자 이름·공백을 정리하고 빈 턴을 버린다. 형식 위반은 모두 모아 돌려준다 */
export function normalizeTranscriptTurns(raw: unknown): ValidationResult<TranscriptTurn[]> {
  const out = new IssueCollector();
  if (!Array.isArray(raw)) {
    out.add('', 'type', 'turns must be an array');
    return out.result([]);
  }
  if (raw.length > MAX_TRANSCRIPT_TURNS) out.add('', 'too_many', `more than ${MAX_TRANSCRIPT_TURNS} turns`);
  const turns: TranscriptTurn[] = [];
  raw.slice(0, MAX_TRANSCRIPT_TURNS).forEach((item: unknown, index) => {
    const path = `turns[${index}]`;
    if (!isPlainObject(item)) return void out.add(path, 'type', 'a turn must be an object');
    const speaker = typeof item['speaker'] === 'string' ? SPEAKER_ALIASES[item['speaker'].trim().toLowerCase()] : undefined;
    if (speaker === undefined) return void out.add(`${path}.speaker`, 'unknown_speaker', `unknown speaker '${String(item['speaker'])}'`);
    if (typeof item['text'] !== 'string') return void out.add(`${path}.text`, 'type', 'text must be a string');
    const text = item['text'].replace(/\s+/g, ' ').trim();
    if (text === '') return; // 침묵·빈 발화는 버린다
    if (text.length > MAX_TURN_CHARS) return void out.add(`${path}.text`, 'too_long', `a turn is longer than ${MAX_TURN_CHARS} characters`);
    const turn: TranscriptTurn = { speaker, text };
    for (const key of ['startedAt', 'endedAt'] as const) {
      const value = item[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || !isIso(value)) out.add(`${path}.${key}`, 'timestamp', `${key} must be an ISO 8601 timestamp`);
      else turn[key] = new Date(value).toISOString();
    }
    turns.push(turn);
  });
  return out.result(turns);
}
