// 정책 문서 형식 v1 (ADR-0013 Amendment 2026-10-19): YAML → 스키마 검증 → 정규화 → 내용 해시.
// 정규화: 기간은 초(정수), 집합 성격의 목록(scope, impact, subject, action, resource)은 정렬, 규칙은 id 순.
// 그래서 주석·공백·키 순서·규칙 순서는 정책 버전(content_hash)을 바꾸지 않는다.
import {
  checkBusinessHours, contentHash, FREE_MAIL_DOMAINS, IMPACTS, isE164, isStrictDomain, IssueCollector, isPlainObject, MEMORY_KINDS, POLICY_DECISIONS, SCOPES,
  type BusinessHours, type Impact, type MemoryKind, type PlainObject, type PolicyDecisionValue, type Scope, type ValidationResult,
} from '@aot/domain';

import { humanOnlyKind, UNCLASSIFIED } from './always-human.ts';
import { parseYaml, YamlError } from './yaml.ts';

export const POLICY_FORMAT = 'aot-policy/v1';

export interface PolicyRule {
  id: string;
  /** 주체 패턴 (`<role>@v<version>`, `*` 와일드카드) */
  subject?: string[];
  /** 행위 패턴 (`<tool>.<operation>`) */
  action?: string[];
  /** 대상 패턴 (`allowed_tools[].target`) */
  resource?: string[];
  scope?: Scope[];
  impact?: Impact[];
  decision: PolicyDecisionValue;
}

export interface RiskyChangeParams {
  min_approvers: number;
  /** 초 */
  cooldown: number;
  reauth_before_effect: boolean;
}

/**
 * 실제로 적용하는 승인 요건. 자기 승인은 문서의 파라미터가 아니라 `min_approvers` 에서 정해진다
 * (D3, 2026-10-19 결정): 승인자가 1인이면 오너(사람)의 자기 승인을 허용하고, 2인 이상이면 금지한다.
 * 허용해도 cooldown·재인증은 그대로 거친다. 에이전트 actor 는 승인 소켓으로는 어떤 경우에도 승인할 수 없다(승인 엔진이 인증 단계에서 거부). 예외 제안: 정책이 선언한 위임 범위 안의 위임 승인(ADR-0016, 소켓 밖 프로세스 내 호출).
 */
export interface ApprovalParams extends RiskyChangeParams {
  self_approval: boolean;
}

export const selfApprovalAllowed = (params: Pick<RiskyChangeParams, 'min_approvers'>): boolean => params.min_approvers === 1;

/** 외부 부작용·정책 변경(위험 변경)의 승인 요건: `risky_change` 파라미터 그대로 */
export const riskyApprovalParams = (document: PolicyDocument): ApprovalParams => ({
  ...document.risky_change,
  self_approval: selfApprovalAllowed(document.risky_change),
});

/** 외부 부작용이 아닌 `require_approval`(예: customer 범위 읽기)의 승인 요건: 사람 1인의 승인만. cooldown·재인증 없음 */
export const humanApprovalParams = (document: PolicyDocument): ApprovalParams => ({
  min_approvers: 1,
  cooldown: 0,
  reauth_before_effect: false,
  self_approval: selfApprovalAllowed(document.risky_change),
});

export interface PolicyLimits {
  max_usd_per_task: number;
  max_tokens_per_task?: number;
}

/** 녹취 정책: 금지 / 요청 시 허용 / 항상 */
export const PHONE_RECORDING_MODES = ['forbidden', 'allowed', 'required'] as const;
export type PhoneRecordingMode = (typeof PHONE_RECORDING_MODES)[number];

/**
 * 전화 정책 섹션 (ADR-0014 §8, 선택). 섹션이 없으면 모든 통화를 거부한다(기본 거부). 이 섹션은 일반 7요소 판정에 더하는 전화 전용 제약이며,
 * 키가 없는 정책 문서의 내용 해시(정책 버전)는 이 섹션이 생기기 전과 같다.
 */
export interface PhonePolicySection {
  /** 발신을 허용하는 국가/지역 번호 접두어 (예: +82) */
  allowed_regions: string[];
  /** 발신 금지 번호 (E.164 정확 일치. 수신거부 등) */
  denied_numbers: string[];
  /** 발신 번호로 쓸 수 있는 번호. 요청이 번호를 밝히지 않으면 첫 번호를 쓴다 */
  caller_ids: string[];
  max_duration_seconds: number;
  /** 최근 24시간 발신 통화 수 상한 — 이 인스턴스 전체의 *총 상한*이다(조직·에이전트를 가리지 않는다). 한 조직이 전체를 소진하지 못하게 하려면 아래 조직 단위 상한을 더한다 */
  max_calls_per_day: number;
  /** 최근 24시간 발신 통화 수 상한 — 조직 단위(통화를 맡은 업무의 org_unit)별. 총 상한 안에서 조직마다 따로 센다. 생략하면 조직별 제한 없음 */
  max_calls_per_day_per_org_unit?: number;
  business_hours?: BusinessHours;
  recording: PhoneRecordingMode;
  /** 전환(사람에게 넘기기) 대상 번호 */
  transfer_targets: string[];
}

/**
 * 위임(mandate) 한도 (ADR-0016, 제안). 모두 이 위임 하나에 대한 것이다.
 * `max_rewrites_per_task` 만 0 을 허용한다(AI 가 다시 쓰게 할 수 없다). 나머지는 양수다.
 */
export interface MandateLimits {
  /** 이 위임으로 한 승인 수 (24시간 창) */
  max_per_day: number;
  max_drafts_per_task: number;
  max_recipients_per_draft: number;
  max_payload_bytes: number;
  /** 업무 cost_budget.max_usd 상한 */
  max_task_usd: number;
  /** AI 의 다시 쓰게 횟수. 넘으면 사람에게 간다 */
  max_rewrites_per_task: number;
  /** 위임 검토 run 비용 (하루) */
  max_review_usd_per_day: number;
}

/**
 * 위임이 보낼 수 있는 받는 사람 규칙 (D-B11). 모든 위임이 선언해야 한다.
 *  - known_contacts: 고객 연락처(`contact` 표)에 active 로 있는 주소만 (권장 기본값)
 *  - domains: 주소의 도메인이 목록과 정확히 같은 것만(소문자, 와일드카드·하위 도메인 없음). 공개 무료 메일 도메인은 넣을 수 없다
 * 어느 쪽이든 suppressed 연락처는 위임으로 보내지 못한다.
 */
export type RecipientRule = { kind: 'known_contacts' } | { kind: 'domains'; domains: string[] };

export interface MandateMatch {
  /** `<도구>.<action>` 패턴 (`*` 와일드카드). 업무의 모든 external_effect 초안이 여기 들어야 한다 */
  actions: string[];
  /** 초안 대상 패턴 */
  targets: string[];
  /** 업무 명세가 그 도구에 선언한 범위. `public` 은 넣을 수 없다 */
  scopes: Scope[];
  /** 받는 사람 규칙 (필수) */
  recipients: RecipientRule;
}

/** 위임 한 건 (ADR-0016 제안). 사람이 정책 배포로 정한 범위 안에서만 보유자(AI)가 승인할 수 있다 */
export interface Mandate {
  /** 정책 안에서 유일 */
  id: string;
  /** 위임을 받는 행위자 id (v1: 에이전트 행위자) */
  holder: string;
  /** v1: 초안 승인 업무(`task`)만 */
  subjects: 'task'[];
  match: MandateMatch;
  limits: MandateLimits;
  /** 초 — 위임 승인 뒤 전송까지. 이 동안 사람이 취소할 수 있다. risky_change.cooldown 이상 */
  cooldown: number;
  /** 사람이 쓴 판단 기준 (500자 이내) */
  guidance: string;
  /** `YYYY-MM-DD` — 그 날의 끝(UTC)까지 유효. 배포 승인 시각부터 90일 이내 */
  expires: string;
}

export interface DelegationSection {
  mandates: Mandate[];
}

export interface PolicyDocument {
  format: typeof POLICY_FORMAT;
  default: 'deny';
  limits: PolicyLimits;
  rules: PolicyRule[];
  risky_change: RiskyChangeParams;
  memory: { default_validity: Partial<Record<MemoryKind, number>> };
  phone?: PhonePolicySection;
  /** 선택. 없으면(또는 mandates 가 비어 있으면) 위임은 꺼져 있다. 키가 없는 문서의 내용 해시는 이 섹션이 생기기 전과 같다 (ADR-0016 제안) */
  delegation?: DelegationSection;
}

/** 값 범위 (D3: min_approvers ≥ 1). 상한은 오타로 승인이 불가능해지는 것을 막는 정도로 둔다. */
export const RISKY_CHANGE_RANGE = { min_approvers: { min: 1, max: 10 }, cooldown_seconds: { min: 0, max: 30 * 86_400 } } as const;
const MAX_VALIDITY_SECONDS = 3650 * 86_400;
const RULE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DURATION = /^([0-9]{1,7})(s|m|h|d)$/;
const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86_400 } as const;

/** `30s`·`15m`·`1h`·`7d` 또는 숫자 0 → 초. 형식이 틀리면 null. */
export function parseDuration(value: unknown): number | null {
  if (value === 0) return 0;
  if (typeof value !== 'string') return null;
  const match = DURATION.exec(value);
  if (!match) return null;
  return Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS];
}

export interface ParsedPolicy {
  document: PolicyDocument;
  /** sha256(정규화 JSON) = policy_version.content_hash */
  hash: string;
  /** 이 내용으로 배포할 때의 policy_version.id */
  versionId: string;
}

export const policyHash = (document: PolicyDocument): string => contentHash(document);
export const policyVersionIdOf = (hash: string): string => `policy-${hash.slice(0, 16)}`;

/** YAML 텍스트를 읽어 검증·정규화한다. */
export function parsePolicy(text: string): ValidationResult<ParsedPolicy> {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    if (error instanceof YamlError) return { ok: false, errors: [{ path: '', code: 'yaml', message: error.message }] };
    throw error;
  }
  const checked = validatePolicyDocument(raw);
  if (!checked.ok) return checked;
  const hash = policyHash(checked.value);
  return { ok: true, value: { document: checked.value, hash, versionId: policyVersionIdOf(hash) } };
}

/** 파싱된 값(또는 JSON)을 검증해 정규화된 문서를 만든다. 모르는 키와 범위 밖 값은 거부한다. */
export function validatePolicyDocument(input: unknown): ValidationResult<PolicyDocument> {
  const out = new IssueCollector();
  if (!isPlainObject(input)) {
    out.add('', 'type', 'a policy must be a mapping');
    return out.result(input as PolicyDocument);
  }
  unknownKeys(input, ['format', 'default', 'limits', 'rules', 'risky_change', 'memory', 'phone', 'delegation'], '', out);
  if (input['format'] !== POLICY_FORMAT) out.add('format', 'format', `format must be '${POLICY_FORMAT}'`);
  if (input['default'] !== 'deny') out.add('default', 'default_deny', "default must be 'deny' (anything not matched by a rule is denied)");

  const limits = checkLimits(input['limits'], out);
  const rules = checkRules(input['rules'], out);
  const risky = checkRiskyChange(input['risky_change'], out);
  const memory = checkMemory(input['memory'], out);
  const phone = checkPhone(input['phone'], out);
  const delegation = checkDelegation(input['delegation'], risky, out);

  const document: PolicyDocument = {
    format: POLICY_FORMAT, default: 'deny', limits, rules, risky_change: risky, memory,
    ...(phone === null ? {} : { phone }), ...(delegation === null ? {} : { delegation }),
  };
  return out.result(document);
}

function unknownKeys(obj: PlainObject, allowed: readonly string[], base: string, out: IssueCollector): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) out.add(base === '' ? key : `${base}.${key}`, 'unknown_key', `unknown key '${key}'`);
  }
}

function checkLimits(value: unknown, out: IssueCollector): PolicyLimits {
  const limits: PolicyLimits = { max_usd_per_task: 0 };
  if (!isPlainObject(value)) {
    out.add('limits', 'required', 'limits is required (at least max_usd_per_task)');
    return limits;
  }
  unknownKeys(value, ['max_usd_per_task', 'max_tokens_per_task'], 'limits', out);
  const usd = value['max_usd_per_task'];
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0 || usd > 1_000_000) {
    out.add('limits.max_usd_per_task', 'range', 'max_usd_per_task must be a number in (0, 1000000]');
  } else {
    limits.max_usd_per_task = usd;
  }
  if ('max_tokens_per_task' in value) {
    const tokens = value['max_tokens_per_task'];
    if (!Number.isInteger(tokens) || (tokens as number) <= 0) out.add('limits.max_tokens_per_task', 'range', 'max_tokens_per_task must be a positive integer');
    else limits.max_tokens_per_task = tokens as number;
  }
  return limits;
}

const MATCHERS = ['subject', 'action', 'resource', 'scope', 'impact'] as const;

function checkRules(value: unknown, out: IssueCollector): PolicyRule[] {
  if (!Array.isArray(value)) {
    out.add('rules', 'required', 'rules must be a list (it may be empty)');
    return [];
  }
  const rules: PolicyRule[] = [];
  const seen = new Set<string>();
  value.forEach((item: unknown, index) => {
    const path = `rules.${index}`;
    if (!isPlainObject(item)) return void out.add(path, 'type', 'each rule must be a mapping');
    unknownKeys(item, ['id', ...MATCHERS, 'decision'], path, out);
    const id = item['id'];
    if (typeof id !== 'string' || !RULE_ID.test(id)) out.add(`${path}.id`, 'format', 'id must match [a-z0-9][a-z0-9-]*');
    else if (seen.has(id)) out.add(`${path}.id`, 'duplicate', `duplicate rule id '${id}'`);
    else seen.add(id);
    const decision = item['decision'];
    if (!(POLICY_DECISIONS as readonly unknown[]).includes(decision)) out.add(`${path}.decision`, 'enum', `decision must be one of ${POLICY_DECISIONS.join('|')}`);

    const rule: PolicyRule = { id: String(id), decision: decision as PolicyDecisionValue };
    let matchers = 0;
    for (const key of MATCHERS) {
      if (!(key in item)) continue;
      matchers += 1;
      const list = item[key];
      const enumValues = key === 'scope' ? SCOPES : key === 'impact' ? IMPACTS : null;
      if (!Array.isArray(list) || list.length === 0) {
        out.add(`${path}.${key}`, 'type', `${key} must be a non-empty list`);
        continue;
      }
      const ok = list.every((entry) => typeof entry === 'string' && entry.trim() !== '' && (enumValues === null || (enumValues as readonly string[]).includes(entry)));
      if (!ok) {
        out.add(`${path}.${key}`, 'enum', enumValues ? `${key} entries must be one of ${enumValues.join('|')}` : `${key} entries must be non-empty strings`);
        continue;
      }
      const sorted = [...new Set(list as string[])].sort();
      if (sorted.length !== list.length) out.add(`${path}.${key}`, 'duplicate', `${key} has duplicate entries`);
      (rule as unknown as Record<string, string[]>)[key] = sorted;
    }
    // 아무 조건 없는 규칙은 모든 요청에 걸린다. 기본 거부를 사실상 바꾸는 규칙이므로 받지 않는다.
    if (matchers === 0) out.add(path, 'catch_all', 'a rule must have at least one of subject/action/resource/scope/impact');
    rules.push(rule);
  });
  return rules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function checkRiskyChange(value: unknown, out: IssueCollector): RiskyChangeParams {
  const params: RiskyChangeParams = { min_approvers: 1, cooldown: 0, reauth_before_effect: true };
  if (!isPlainObject(value)) {
    out.add('risky_change', 'required', 'risky_change is required (min_approvers, cooldown, reauth_before_effect)');
    return params;
  }
  unknownKeys(value, ['min_approvers', 'cooldown', 'reauth_before_effect', 'self_approval'], 'risky_change', out);
  const approvers = value['min_approvers'];
  const range = RISKY_CHANGE_RANGE.min_approvers;
  if (!Number.isInteger(approvers) || (approvers as number) < range.min || (approvers as number) > range.max) {
    out.add('risky_change.min_approvers', 'range', `min_approvers must be an integer in [${range.min}, ${range.max}]`);
  } else {
    params.min_approvers = approvers as number;
  }
  const cooldown = parseDuration(value['cooldown']);
  const cooldownRange = RISKY_CHANGE_RANGE.cooldown_seconds;
  if (cooldown === null || cooldown < cooldownRange.min || cooldown > cooldownRange.max) {
    out.add('risky_change.cooldown', 'range', 'cooldown must be a duration like 1h (s|m|h|d) or 0, at most 30d');
  } else {
    params.cooldown = cooldown;
  }
  if (typeof value['reauth_before_effect'] !== 'boolean') out.add('risky_change.reauth_before_effect', 'type', 'reauth_before_effect must be true or false');
  else params.reauth_before_effect = value['reauth_before_effect'];
  if ('self_approval' in value) {
    out.add('risky_change.self_approval', 'removed', 'self_approval is not a parameter: self-approval is allowed only when min_approvers is 1 (always forbidden for 2 or more)');
  }
  return params;
}

function checkMemory(value: unknown, out: IssueCollector): PolicyDocument['memory'] {
  const memory: PolicyDocument['memory'] = { default_validity: {} };
  if (value === undefined) return memory;
  if (!isPlainObject(value)) {
    out.add('memory', 'type', 'memory must be a mapping');
    return memory;
  }
  unknownKeys(value, ['default_validity'], 'memory', out);
  const validity = value['default_validity'];
  if (validity === undefined || validity === null) return memory;
  if (!isPlainObject(validity)) {
    out.add('memory.default_validity', 'type', 'default_validity must be a mapping of kind → duration');
    return memory;
  }
  for (const [kind, raw] of Object.entries(validity).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const path = `memory.default_validity.${kind}`;
    // memory-item 규칙 6: commitment 는 만료로 stale 이 되지 않는다.
    if (!(MEMORY_KINDS as readonly string[]).includes(kind) || kind === 'commitment') {
      out.add(path, 'enum', `kind must be one of ${MEMORY_KINDS.filter((k) => k !== 'commitment').join('|')}`);
      continue;
    }
    const seconds = parseDuration(raw);
    if (seconds === null || seconds <= 0 || seconds > MAX_VALIDITY_SECONDS) out.add(path, 'range', 'must be a positive duration (s|m|h|d), at most 3650d');
    else memory.default_validity[kind as MemoryKind] = seconds;
  }
  return memory;
}

const REGION_PREFIX = /^\+[1-9][0-9]{0,7}$/;

function checkPhone(value: unknown, out: IssueCollector): PhonePolicySection | null {
  if (value === undefined) return null;
  if (!isPlainObject(value)) {
    out.add('phone', 'type', 'phone must be a mapping');
    return null;
  }
  unknownKeys(value, ['allowed_regions', 'denied_numbers', 'caller_ids', 'max_duration_seconds', 'max_calls_per_day', 'max_calls_per_day_per_org_unit', 'business_hours', 'recording', 'transfer_targets'], 'phone', out);
  const list = (key: string, required: boolean, ok: (item: string) => boolean, what: string): string[] => {
    const raw = value[key];
    const path = `phone.${key}`;
    if (raw === undefined) {
      if (required) out.add(path, 'required', `${key} is required (${what})`);
      return [];
    }
    if (!Array.isArray(raw) || (required && raw.length === 0) || !raw.every((item) => typeof item === 'string' && ok(item))) {
      out.add(path, 'format', `${key} must be ${required ? 'a non-empty' : 'a'} list of ${what}`);
      return [];
    }
    return [...new Set(raw as string[])].sort();
  };
  const section: PhonePolicySection = {
    allowed_regions: list('allowed_regions', true, (item) => REGION_PREFIX.test(item), 'calling-code prefixes such as +82'),
    denied_numbers: list('denied_numbers', false, isE164, 'E.164 numbers'),
    caller_ids: list('caller_ids', true, isE164, 'E.164 numbers'),
    max_duration_seconds: 0,
    max_calls_per_day: 0,
    recording: 'forbidden',
    transfer_targets: list('transfer_targets', false, isE164, 'E.164 numbers'),
  };
  const seconds = value['max_duration_seconds'];
  if (!Number.isInteger(seconds) || (seconds as number) < 10 || (seconds as number) > 14_400) out.add('phone.max_duration_seconds', 'range', 'max_duration_seconds must be an integer in [10, 14400]');
  else section.max_duration_seconds = seconds as number;
  const perDay = value['max_calls_per_day'];
  if (!Number.isInteger(perDay) || (perDay as number) < 1 || (perDay as number) > 10_000) out.add('phone.max_calls_per_day', 'range', 'max_calls_per_day must be an integer in [1, 10000]');
  else section.max_calls_per_day = perDay as number;
  if ('max_calls_per_day_per_org_unit' in value) {
    const perUnit = value['max_calls_per_day_per_org_unit'];
    if (!Number.isInteger(perUnit) || (perUnit as number) < 1 || (perUnit as number) > 10_000) out.add('phone.max_calls_per_day_per_org_unit', 'range', 'max_calls_per_day_per_org_unit must be an integer in [1, 10000]');
    else section.max_calls_per_day_per_org_unit = perUnit as number;
  }
  if ('recording' in value) {
    if (!(PHONE_RECORDING_MODES as readonly unknown[]).includes(value['recording'])) out.add('phone.recording', 'enum', `recording must be one of ${PHONE_RECORDING_MODES.join('|')}`);
    else section.recording = value['recording'] as PhoneRecordingMode;
  }
  if (value['business_hours'] !== undefined) {
    const hours = checkBusinessHours(value['business_hours'], 'phone.business_hours', out);
    if (hours) section.business_hours = hours;
  }
  return section;
}

// ===== 위임 (ADR-0016, 제안) =====

/** 위임 만료의 상한: 배포 승인 시각부터 일 수 */
export const DELEGATION_MAX_DAYS = 90;
const MANDATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOLDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_GUIDANCE_CHARS = 500;

/** 위임 만료 시각 (그 날 UTC 의 마지막 순간). 날짜 형식이 아니면 null */
export function mandateExpiresAt(expires: string): string | null {
  if (!DATE_ONLY.test(expires)) return null;
  const date = new Date(`${expires}T23:59:59.999Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== expires) return null;
  return date.toISOString();
}

const MANDATE_LIMIT_SPEC = {
  max_per_day: { integer: true, min: 1, max: 1000, exclusiveMin: false },
  max_drafts_per_task: { integer: true, min: 1, max: 20, exclusiveMin: false },
  max_recipients_per_draft: { integer: true, min: 1, max: 100, exclusiveMin: false },
  max_payload_bytes: { integer: true, min: 1, max: 262_144, exclusiveMin: false },
  max_task_usd: { integer: false, min: 0, max: 1_000_000, exclusiveMin: true },
  max_rewrites_per_task: { integer: true, min: 0, max: 10, exclusiveMin: false },
  max_review_usd_per_day: { integer: false, min: 0, max: 1_000_000, exclusiveMin: true },
} as const;

function checkDelegation(value: unknown, risky: RiskyChangeParams, out: IssueCollector): DelegationSection | null {
  if (value === undefined) return null;
  if (!isPlainObject(value)) {
    out.add('delegation', 'type', 'delegation must be a mapping');
    return null;
  }
  unknownKeys(value, ['mandates'], 'delegation', out);
  const list = value['mandates'];
  if (!Array.isArray(list)) {
    out.add('delegation.mandates', 'type', 'delegation.mandates must be a list');
    return null;
  }
  if (list.length === 0) return null; // 위임이 하나도 없는 섹션은 섹션이 없는 것과 같다 (정규화: 키를 지운다)
  // 위임 승인은 승인자 한 명 몫을 채우는 규칙만 정의한다 (D-B7): 2인 이상이 필요한 정책에서는 위임을 받지 않는다
  if (risky.min_approvers !== 1) {
    out.add('delegation', 'min_approvers', `delegation is only allowed when risky_change.min_approvers is 1 (it is ${risky.min_approvers}): a delegated approval fills one approver's share`);
  }
  const mandates: Mandate[] = [];
  const seen = new Set<string>();
  list.forEach((item: unknown, index) => {
    const path = `delegation.mandates.${index}`;
    if (!isPlainObject(item)) return void out.add(path, 'type', 'each mandate must be a mapping');
    unknownKeys(item, ['id', 'holder', 'subjects', 'match', 'limits', 'cooldown', 'guidance', 'expires'], path, out);
    const id = item['id'];
    if (typeof id !== 'string' || !MANDATE_ID.test(id)) out.add(`${path}.id`, 'format', 'id must match [a-z0-9][a-z0-9-]*');
    else if (seen.has(id)) out.add(`${path}.id`, 'duplicate', `duplicate mandate id '${id}'`);
    else seen.add(id);
    const holder = item['holder'];
    if (typeof holder !== 'string' || !HOLDER_ID.test(holder)) out.add(`${path}.holder`, 'format', 'holder must be an actor id');
    const subjects = item['subjects'];
    if (Array.isArray(subjects) && subjects.some((entry) => entry !== 'task' && humanOnlyKind(entry) !== null && humanOnlyKind(entry) !== UNCLASSIFIED)) {
      // 항상 사람이 정하는 결정(정책 배포·조직 변경·게시·상품 등록 …)은 위임 대상으로 적을 수 없다 (ADR-0016 Decision 5)
      out.add(`${path}.subjects`, 'always_human', `subjects cannot name an always-human decision (${subjects.filter((entry) => humanOnlyKind(entry) !== null && entry !== 'task').map(String).join(', ')}): those are decided by a person only`);
    } else if (!Array.isArray(subjects) || subjects.length === 0 || !subjects.every((entry) => entry === 'task')) {
      out.add(`${path}.subjects`, 'enum', "subjects must be ['task'] (v1 delegates only draft-approval tasks)");
    }
    const match = checkMandateMatch(item['match'], `${path}.match`, out);
    const limits = checkMandateLimits(item['limits'], `${path}.limits`, out);
    const cooldown = parseDuration(item['cooldown']);
    if (cooldown === null || cooldown > RISKY_CHANGE_RANGE.cooldown_seconds.max) {
      out.add(`${path}.cooldown`, 'range', 'cooldown must be a duration like 1h (s|m|h|d) or 0, at most 30d');
    } else if (cooldown < risky.cooldown) {
      out.add(`${path}.cooldown`, 'range', `cooldown must be at least risky_change.cooldown (${risky.cooldown}s): a delegated approval must leave a person at least as long to cancel`);
    }
    const guidance = item['guidance'];
    if (typeof guidance !== 'string' || guidance.trim() === '' || guidance.length > MAX_GUIDANCE_CHARS) {
      out.add(`${path}.guidance`, 'range', `guidance is required: the human-written criteria, 1 to ${MAX_GUIDANCE_CHARS} characters`);
    }
    const expires = item['expires'];
    if (typeof expires !== 'string' || mandateExpiresAt(expires) === null) out.add(`${path}.expires`, 'format', 'expires is required, a date like 2027-01-31');
    mandates.push({
      id: String(id), holder: String(holder), subjects: ['task'], match, limits, cooldown: cooldown ?? 0,
      guidance: typeof guidance === 'string' ? guidance : '', expires: typeof expires === 'string' ? expires : '',
    });
  });
  return { mandates: mandates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
}

function checkMandateMatch(value: unknown, path: string, out: IssueCollector): MandateMatch {
  const match: MandateMatch = { actions: [], targets: [], scopes: [], recipients: { kind: 'known_contacts' } };
  if (!isPlainObject(value)) {
    out.add(path, 'required', 'match is required (actions, targets, scopes, recipients)');
    return match;
  }
  unknownKeys(value, ['actions', 'targets', 'scopes', 'recipients'], path, out);
  const strings = (key: 'actions' | 'targets', ok: (entry: string) => boolean, what: string): string[] => {
    const raw = value[key];
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every((entry) => typeof entry === 'string' && entry.trim() !== '' && ok(entry))) {
      out.add(`${path}.${key}`, 'type', `${key} must be a non-empty list of ${what}`);
      return [];
    }
    return [...new Set(raw as string[])].sort();
  };
  match.actions = strings('actions', (entry) => entry.includes('.'), "'<tool>.<action>' patterns");
  match.targets = strings('targets', () => true, 'target patterns');
  const scopes = value['scopes'];
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((entry) => (SCOPES as readonly unknown[]).includes(entry))) {
    out.add(`${path}.scopes`, 'enum', `scopes must be a non-empty list of ${SCOPES.filter((scope) => scope !== 'public').join('|')}`);
  } else if (scopes.includes('public')) {
    out.add(`${path}.scopes`, 'public_scope', "scopes must not include 'public': public posting is always decided by a person");
  } else {
    match.scopes = [...new Set(scopes as Scope[])].sort();
  }
  match.recipients = checkRecipientRule(value['recipients'], `${path}.recipients`, out);
  return match;
}

function checkRecipientRule(value: unknown, path: string, out: IssueCollector): RecipientRule {
  const fallback: RecipientRule = { kind: 'known_contacts' };
  if (value === undefined) {
    out.add(path, 'required', "recipients is required: every mandate must say who it may send to (recipients: { kind: known_contacts } or { kind: domains, domains: [...] })");
    return fallback;
  }
  if (!isPlainObject(value)) {
    out.add(path, 'type', 'recipients must be a mapping with a kind');
    return fallback;
  }
  if (value['kind'] === 'known_contacts') {
    unknownKeys(value, ['kind'], path, out);
    return fallback;
  }
  if (value['kind'] !== 'domains') {
    out.add(`${path}.kind`, 'enum', "recipients.kind must be 'known_contacts' or 'domains'");
    return fallback;
  }
  unknownKeys(value, ['kind', 'domains'], path, out);
  const raw = value['domains'];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) {
    out.add(`${path}.domains`, 'type', 'domains must be a list of 1 to 100 exact domains such as example.com');
    return fallback;
  }
  const domains = new Set<string>();
  raw.forEach((entry: unknown, index) => {
    const at = `${path}.domains.${index}`;
    const domain = typeof entry === 'string' ? entry.trim().toLowerCase() : null;
    if (domain === null || !isStrictDomain(domain)) {
      out.add(at, 'format', 'each domain must be an exact domain such as example.com (no wildcard, no @, no sub-domain pattern)');
    } else if (FREE_MAIL_DOMAINS.includes(domain)) {
      out.add(at, 'free_mail_domain', `'${domain}' is a public free-mail domain: allow-listing it would let anyone be a recipient. Use known_contacts instead`);
    } else {
      domains.add(domain);
    }
  });
  return { kind: 'domains', domains: [...domains].sort() };
}

function checkMandateLimits(value: unknown, path: string, out: IssueCollector): MandateLimits {
  const limits: MandateLimits = {
    max_per_day: 1, max_drafts_per_task: 1, max_recipients_per_draft: 1, max_payload_bytes: 1, max_task_usd: 1, max_rewrites_per_task: 0, max_review_usd_per_day: 1,
  };
  if (!isPlainObject(value)) {
    out.add(path, 'required', `limits is required (${Object.keys(MANDATE_LIMIT_SPEC).join(', ')})`);
    return limits;
  }
  unknownKeys(value, Object.keys(MANDATE_LIMIT_SPEC), path, out);
  for (const [key, spec] of Object.entries(MANDATE_LIMIT_SPEC)) {
    const raw = value[key];
    const below = typeof raw === 'number' && (spec.exclusiveMin ? raw <= spec.min : raw < spec.min);
    if (typeof raw !== 'number' || !Number.isFinite(raw) || (spec.integer && !Number.isInteger(raw)) || below || raw > spec.max) {
      out.add(`${path}.${key}`, 'range', `${key} must be ${spec.integer ? 'an integer' : 'a number'} ${spec.exclusiveMin ? 'greater than' : 'at least'} ${spec.min} and at most ${spec.max}`);
    } else {
      (limits as unknown as Record<string, number>)[key] = raw;
    }
  }
  return limits;
}

/** memory-item 규칙 5: 정책의 기본 만료 기간 → domain MemoryContext.defaultValiditySeconds */
export function memoryDefaultValidity(document: PolicyDocument): (kind: MemoryKind) => number | null {
  return (kind) => document.memory.default_validity[kind] ?? null;
}
