// 조사 결과의 `uncertainties` (docs/schema/task-spec.md "불확실성 항목이 명시되어 있다", 검사 id `uncertainty_listed`).
// 조사 에이전트가 *스스로 아는* 불확실성(읽지 못한 출처, 찾지 못한 인용문, 건너뛴 입력)을 `{topic, note}` 목록으로 결과에 싣는다.
// 이 모듈은 결과가 그 형식을 지키는지만 본다. 목록이 비어 있어도 형식은 유효하다: "알려진 불확실성이 없다"는 에이전트의 명시이며, 필드 자체가 없는 것(말하지 않음)과 다르다.
// 상한 값은 컨테이너 이미지의 core.ts 가 복사해 가지고 있다(이미지는 이 패키지를 import 할 수 없다). 시험(research-agent-core.test.ts)이 두 값을 대조한다.

export const MAX_UNCERTAINTIES = 100;
export const MAX_UNCERTAINTY_TOPIC_CHARS = 100;
export const MAX_UNCERTAINTY_NOTE_CHARS = 300;

export interface Uncertainty {
  topic: string;
  note: string;
}

export type UncertaintiesCheck = { ok: true; items: Uncertainty[] } | { ok: false; reason: string };

/** 서로 다른 형식 오류를 이만큼까지만 사유에 적는다 */
const MAX_REPORTED_PROBLEMS = 5;

/** `run.result`(JSON 문자열)에서 `uncertainties` 를 읽고 형식을 확인한다. 필드 누락과 형식 오류는 `ok:false` 와 사유다 */
export function uncertaintiesFromResult(result: string | null): UncertaintiesCheck {
  if (result === null) return { ok: false, reason: 'the run submitted no result' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return { ok: false, reason: 'the run result is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: 'the run result is not a JSON object' };
  if (!Object.hasOwn(parsed, 'uncertainties')) {
    return { ok: false, reason: "the result has no 'uncertainties' field (list the known uncertainties, or an empty list when there are none)" };
  }
  const list = (parsed as { uncertainties: unknown }).uncertainties;
  if (!Array.isArray(list)) return { ok: false, reason: "'uncertainties' is not an array" };
  if (list.length > MAX_UNCERTAINTIES) return { ok: false, reason: `'uncertainties' has ${list.length} items (at most ${MAX_UNCERTAINTIES})` };
  const items: Uncertainty[] = [];
  const problems: string[] = [];
  list.forEach((item: unknown, index) => {
    const at = `uncertainties[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      problems.push(`${at} is not an object`);
      return;
    }
    const entry = item as Record<string, unknown>;
    const extra = Object.keys(entry).filter((key) => key !== 'topic' && key !== 'note');
    if (extra.length > 0) problems.push(`${at} has unknown key(s): ${extra.join(', ')}`);
    const { topic, note } = entry;
    if (typeof topic !== 'string' || topic.trim() === '') problems.push(`${at}.topic must be a non-empty string`);
    else if (topic.length > MAX_UNCERTAINTY_TOPIC_CHARS) problems.push(`${at}.topic is longer than ${MAX_UNCERTAINTY_TOPIC_CHARS} characters`);
    if (typeof note !== 'string' || note.trim() === '') problems.push(`${at}.note must be a non-empty string`);
    else if (note.length > MAX_UNCERTAINTY_NOTE_CHARS) problems.push(`${at}.note is longer than ${MAX_UNCERTAINTY_NOTE_CHARS} characters`);
    if (typeof topic === 'string' && typeof note === 'string') items.push({ topic, note });
  });
  if (problems.length > 0) {
    const shown = problems.slice(0, MAX_REPORTED_PROBLEMS).join('; ');
    return { ok: false, reason: `'uncertainties' is malformed: ${shown}${problems.length > MAX_REPORTED_PROBLEMS ? ` (and ${problems.length - MAX_REPORTED_PROBLEMS} more)` : ''}` };
  }
  return { ok: true, items };
}
