// 정책 문서 형식 v1 (ADR-0013 Amendment 2026-10-19): YAML → 스키마 검증 → 정규화 → 내용 해시.
// 정규화: 기간은 초(정수), 집합 성격의 목록(scope, impact, subject, action, resource)은 정렬, 규칙은 id 순.
// 그래서 주석·공백·키 순서·규칙 순서는 정책 버전(content_hash)을 바꾸지 않는다.
import {
  contentHash, IMPACTS, IssueCollector, isPlainObject, MEMORY_KINDS, POLICY_DECISIONS, SCOPES,
  type Impact, type MemoryKind, type PlainObject, type PolicyDecisionValue, type Scope, type ValidationResult,
} from '@aot/domain';

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
 * 허용해도 cooldown·재인증은 그대로 거친다. 에이전트 actor 는 어떤 경우에도 승인할 수 없다(승인 엔진이 인증 단계에서 거부).
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

export interface PolicyDocument {
  format: typeof POLICY_FORMAT;
  default: 'deny';
  limits: PolicyLimits;
  rules: PolicyRule[];
  risky_change: RiskyChangeParams;
  memory: { default_validity: Partial<Record<MemoryKind, number>> };
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
  unknownKeys(input, ['format', 'default', 'limits', 'rules', 'risky_change', 'memory'], '', out);
  if (input['format'] !== POLICY_FORMAT) out.add('format', 'format', `format must be '${POLICY_FORMAT}'`);
  if (input['default'] !== 'deny') out.add('default', 'default_deny', "default must be 'deny' (anything not matched by a rule is denied)");

  const limits = checkLimits(input['limits'], out);
  const rules = checkRules(input['rules'], out);
  const risky = checkRiskyChange(input['risky_change'], out);
  const memory = checkMemory(input['memory'], out);

  const document: PolicyDocument = { format: POLICY_FORMAT, default: 'deny', limits, rules, risky_change: risky, memory };
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

/** memory-item 규칙 5: 정책의 기본 만료 기간 → domain MemoryContext.defaultValiditySeconds */
export function memoryDefaultValidity(document: PolicyDocument): (kind: MemoryKind) => number | null {
  return (kind) => document.memory.default_validity[kind] ?? null;
}
