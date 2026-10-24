// 측정 신호 정의 형식 (D2, A6-U10). 팩이 선언하고(ADR-0012 §1) 평가기가 읽는다(ADR-0007).
// 형식만 본다. 실제 페이지 주소·제품·행동의 실제 이름은 `instance/` 에만 두고, 정의에는 별칭 키(`page_ref`)만 쓴다 (공개 저장소 규칙).
// Phase A 는 사람이 값을 입력하고 근거를 `evidence` 로 첨부하므로 `attachment_required` 는 true 로 고정이다 (읽기 전용 분석 API 연결은 후속).
import {
  IssueCollector, isNonBlankString, isPlainObject, rejectUnknownKeys, type ValidationResult,
} from '../validation.ts';

/** 집계 주기. 지금은 ISO 8601 주(월~일, `tz` 기준)만 있다 */
export const MEASUREMENT_PERIODS = ['iso_week'] as const;
export type MeasurementPeriod = (typeof MEASUREMENT_PERIODS)[number];

export const MAX_MEASUREMENT_DESCRIPTION_CHARS = 500;

export interface MeasurementSignal {
  /** 팩 안에서 유일한 id (소문자·숫자·하이픈) */
  id: string;
  description: string;
  /** 측정 대상 페이지의 별칭 키 `<종류>:<이름>` (예: `landing:example-product`). 실제 주소는 `instance/` 에만 둔다 */
  page_ref: string;
  /** 목표 행동 이름 (소문자·숫자·밑줄, 예: `signup`) */
  action: string;
  period: MeasurementPeriod;
  /** 주 경계를 정하는 IANA 시간대 */
  tz: string;
  /** 판정에 필요한 주당 최소 관측 수 (정수 ≥ 1) */
  min_observations: number;
  /** Phase A 는 근거 첨부가 필수다 */
  attachment_required: true;
  /** 선택. 단위 없는 수 */
  pass_threshold?: number;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
const PAGE_REF = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;
const ACTION = /^[a-z][a-z0-9_]*$/;
// IANA 이름만: 영문자로 시작하고 `/` 로 지역을 나눈다. 오프셋(`+09:00`)은 Intl 이 받아도 거부한다 (task-engine/schedule.ts 와 같은 규칙).
const TZ_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;
const URL_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.)/i;

function isKnownTimeZone(tz: string): boolean {
  if (!TZ_NAME.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateMeasurementSignal(input: unknown): ValidationResult<MeasurementSignal> {
  const out = new IssueCollector();
  if (!isPlainObject(input)) {
    out.add('', 'type', 'measurement signal must be a JSON object');
    return out.result(input as MeasurementSignal);
  }
  rejectUnknownKeys(input, ['id', 'description', 'page_ref', 'action', 'period', 'tz', 'min_observations', 'attachment_required', 'pass_threshold'], '', out);

  const text = (key: 'id' | 'description' | 'page_ref' | 'action' | 'tz', pattern: RegExp | null, hint: string): void => {
    const value = input[key];
    if (!isNonBlankString(value)) return void out.add(key, 'required', `${key} is required (${hint})`);
    if (pattern !== null && !pattern.test(value)) out.add(key, 'format', `${key} ${hint}`);
    // 정의는 공개 저장소에 들어간다. 주소가 섞이면 실제 값이 새어 나가기 쉬우므로 형식과 상관없이 막는다.
    if (URL_LIKE.test(value)) out.add(key, 'url_not_allowed', `${key} must not contain a URL; keep real addresses in instance/ and use an alias key`);
  };
  text('id', ID, 'must be lowercase letters, digits and hyphens');
  text('description', null, 'a short sentence');
  if (isNonBlankString(input['description']) && input['description'].length > MAX_MEASUREMENT_DESCRIPTION_CHARS) {
    out.add('description', 'too_long', `description is at most ${MAX_MEASUREMENT_DESCRIPTION_CHARS} characters`);
  }
  text('page_ref', PAGE_REF, 'must be an alias key "<kind>:<name>" in lowercase (for example landing:example-product), not an address');
  text('action', ACTION, 'must be lowercase letters, digits and underscores (for example signup)');

  if (!(MEASUREMENT_PERIODS as readonly unknown[]).includes(input['period'])) {
    out.add('period', 'enum', `period must be one of ${MEASUREMENT_PERIODS.join('|')}`);
  }

  const tz = input['tz'];
  if (!isNonBlankString(tz)) out.add('tz', 'required', 'tz is required (an IANA time zone such as Asia/Seoul)');
  else if (!isKnownTimeZone(tz)) out.add('tz', 'format', `tz '${tz}' is not an IANA time zone name`);

  const min = input['min_observations'];
  if (typeof min !== 'number' || !Number.isInteger(min) || min < 1) out.add('min_observations', 'range', 'min_observations must be an integer >= 1');

  // true 만 받는다. 생략도 거부한다: 근거 없는 수동 입력이 조용히 허용되면 안 된다.
  if (input['attachment_required'] !== true) out.add('attachment_required', 'must_be_true', 'attachment_required must be true (Phase A requires an attached evidence for every manual value)');

  if ('pass_threshold' in input) {
    const threshold = input['pass_threshold'];
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) out.add('pass_threshold', 'type', 'pass_threshold must be a finite number (unitless)');
  }
  return out.result(input as unknown as MeasurementSignal);
}
