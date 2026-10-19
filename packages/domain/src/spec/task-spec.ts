// task_spec 스키마 검증 (docs/schema/task-spec.md). task.spec 에 JSON 으로 저장하기 전에 통과해야 한다.
//
// 두 단계가 있다.
//  - 'draft':  작성자(템플릿, 에이전트, 사람)가 낸 명세. 시스템이 채우는 필드(policy_version, versions, approved_snapshot)가 있으면 거부한다.
//  - 'stored': 시스템이 policy_version·versions 를 채운 뒤의 명세. 두 필드가 필수다.
// 알 수 없는 필드는 거부한다. 특히 constraints 의 모르는 항목을 조용히 무시하면 제한이 걸린 것처럼 보이기 때문이다.
//
// 여기서 하지 않는 것(다른 단계의 몫): 정책 판정과 정책 상한(A3), 의존 순환 검사(업무 id 가 생기는 생성 시점, A2).
// 역할·상품·선행 업무의 존재 확인은 DB 가 필요하므로 spec-references.ts 에 있다.
import { IMPACTS, SCOPES, SENSITIVITIES, TRIGGER_KINDS, type Impact, type Scope, type Sensitivity, type TriggerKind } from '../entities/enums.ts';
import {
  IssueCollector, isNonBlankString, isPlainObject, joinPath, rejectUnknownKeys,
  type PlainObject, type ValidationResult,
} from '../validation.ts';

export interface TaskTrigger { kind: TriggerKind; ref: string }
export interface TaskInput { name: string; ref: string; kind: string }

export interface ToolRequest {
  tool: string;
  operations: string[];
  scope?: Scope;
  impact?: Impact;
  target?: string;
}

export interface TaskConstraints {
  time_limit?: string;
  /** 명시적 도메인 목록. 비면 네트워크 없음. `"*"` 금지 */
  network_allowlist?: string[];
  fs_scope?: string[];
  publish_scope?: Scope;
  data_classes?: Sensitivity[];
}

export interface TaskValidation {
  deterministic: string[];
  llm: { check: string; isolated_context?: boolean } | null;
  human: boolean;
}

export interface CostBudget { max_usd: number; max_tokens?: number }

export interface TaskSpecVersions {
  org_version: string | number | null;
  role_version: string | number | null;
  task_spec_version: string | number | null;
  strategy_version: string | number | null;
  tool_contract_version: string | number | null;
}

/** 작성자가 내는 명세 */
export interface TaskSpecDraft {
  objective: string;
  department?: string;
  role?: string;
  product?: string;
  trigger: TaskTrigger;
  inputs: TaskInput[];
  dependencies?: string[];
  allowed_tools: ToolRequest[];
  constraints: TaskConstraints;
  acceptance_criteria: string[];
  validation: TaskValidation;
  evidence_refs?: string[];
  cost_budget: CostBudget;
}

/** 시스템이 채운 뒤 task.spec 에 저장되는 명세 */
export interface TaskSpec extends TaskSpecDraft {
  policy_version: string;
  versions: TaskSpecVersions;
  approved_snapshot?: PlainObject;
}

export type TaskSpecStage = 'draft' | 'stored';

const DRAFT_KEYS = [
  'objective', 'department', 'role', 'product', 'trigger', 'inputs', 'dependencies', 'allowed_tools',
  'constraints', 'acceptance_criteria', 'validation', 'evidence_refs', 'cost_budget',
] as const;
/** 시스템만 채우는 필드 */
export const SYSTEM_FILLED_FIELDS = ['policy_version', 'versions', 'approved_snapshot'] as const;
const VERSION_KEYS = ['org_version', 'role_version', 'task_spec_version', 'strategy_version', 'tool_contract_version'] as const;

export function validateTaskSpec(input: unknown, stage: 'draft'): ValidationResult<TaskSpecDraft>;
export function validateTaskSpec(input: unknown, stage: 'stored'): ValidationResult<TaskSpec>;
export function validateTaskSpec(input: unknown, stage: TaskSpecStage): ValidationResult<TaskSpecDraft | TaskSpec> {
  const out = new IssueCollector();
  if (!isPlainObject(input)) {
    out.add('', 'type', 'task_spec must be a JSON object');
    return out.result(input as TaskSpecDraft);
  }

  if (stage === 'draft') {
    for (const field of SYSTEM_FILLED_FIELDS) {
      if (field in input) out.add(field, 'system_field', `'${field}' is filled by the system; it cannot be specified`);
    }
  } else {
    checkStoredFields(input, out);
  }
  rejectUnknownKeys(input, [...DRAFT_KEYS, ...SYSTEM_FILLED_FIELDS], '', out);

  requiredText(input, 'objective', '', out, 'objective must be a non-empty sentence');
  for (const key of ['department', 'role', 'product'] as const) optionalText(input, key, out);
  checkTrigger(input['trigger'], out);
  checkInputs(input['inputs'], out);
  checkDependencies(input['dependencies'], out);
  checkAllowedTools(input['allowed_tools'], out);
  checkConstraints(input['constraints'], out);
  checkAcceptanceCriteria(input['acceptance_criteria'], out);
  checkValidation(input['validation'], out);
  checkStringList(input['evidence_refs'], 'evidence_refs', out, { required: false });
  checkCostBudget(input['cost_budget'], out);

  return out.result(input as unknown as TaskSpecDraft);
}

function checkStoredFields(spec: PlainObject, out: IssueCollector): void {
  if (!isNonBlankString(spec['policy_version'])) out.add('policy_version', 'required', 'policy_version is required (filled by the system)');
  const versions = spec['versions'];
  if (!isPlainObject(versions)) {
    out.add('versions', 'required', 'versions is required (filled by the system)');
  } else {
    rejectUnknownKeys(versions, VERSION_KEYS, 'versions', out);
    for (const key of VERSION_KEYS) {
      const value = versions[key];
      const ok = value === null || (typeof value === 'string' && value !== '') || (typeof value === 'number' && Number.isFinite(value));
      if (!ok) out.add(joinPath('versions', key), 'type', `${key} must be a non-empty string, a number, or null`);
    }
  }
  if ('approved_snapshot' in spec && !isPlainObject(spec['approved_snapshot'])) {
    out.add('approved_snapshot', 'type', 'approved_snapshot must be an object');
  }
}

function requiredText(obj: PlainObject, key: string, base: string, out: IssueCollector, message?: string): void {
  if (!isNonBlankString(obj[key])) out.add(joinPath(base, key), 'required', message ?? `${key} must be a non-empty string`);
}

function optionalText(obj: PlainObject, key: string, out: IssueCollector): void {
  if (key in obj && !isNonBlankString(obj[key])) out.add(key, 'type', `${key} must be a non-empty string when given (omit it instead of leaving it empty)`);
}

function checkTrigger(value: unknown, out: IssueCollector): void {
  if (!isPlainObject(value)) return void out.add('trigger', 'required', "trigger must be {kind, ref}");
  rejectUnknownKeys(value, ['kind', 'ref'], 'trigger', out);
  if (!(TRIGGER_KINDS as readonly unknown[]).includes(value['kind'])) {
    out.add('trigger.kind', 'enum', `trigger.kind must be one of ${TRIGGER_KINDS.join('|')}`);
  }
  requiredText(value, 'ref', 'trigger', out, 'trigger.ref is required');
}

function checkInputs(value: unknown, out: IssueCollector): void {
  if (!Array.isArray(value)) return void out.add('inputs', 'required', 'inputs must be an array of {name, ref, kind}');
  value.forEach((item: unknown, index) => {
    const path = joinPath('inputs', index);
    if (!isPlainObject(item)) return void out.add(path, 'type', 'each input must be {name, ref, kind}');
    rejectUnknownKeys(item, ['name', 'ref', 'kind'], path, out);
    requiredText(item, 'name', path, out);
    requiredText(item, 'ref', path, out, 'an input without a source (ref) is rejected');
    requiredText(item, 'kind', path, out);
  });
}

function checkDependencies(value: unknown, out: IssueCollector): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) return void out.add('dependencies', 'type', 'dependencies must be an array of task ids');
  const seen = new Set<string>();
  value.forEach((id: unknown, index) => {
    const path = joinPath('dependencies', index);
    if (!isNonBlankString(id)) return void out.add(path, 'type', 'dependency must be a non-empty task id');
    if (seen.has(id)) out.add(path, 'duplicate', `duplicate dependency '${id}'`);
    seen.add(id);
  });
}

function checkAllowedTools(value: unknown, out: IssueCollector): void {
  if (!Array.isArray(value)) return void out.add('allowed_tools', 'required', 'allowed_tools must be an array (it may be empty)');
  value.forEach((item: unknown, index) => {
    const path = joinPath('allowed_tools', index);
    if (!isPlainObject(item)) return void out.add(path, 'type', 'each entry must be {tool, operations, scope?, impact?, target?}');
    rejectUnknownKeys(item, ['tool', 'operations', 'scope', 'impact', 'target'], path, out);
    requiredText(item, 'tool', path, out);
    checkStringList(item['operations'], joinPath(path, 'operations'), out, { required: true, nonEmpty: true });
    if ('scope' in item && !(SCOPES as readonly unknown[]).includes(item['scope'])) out.add(joinPath(path, 'scope'), 'enum', `scope must be one of ${SCOPES.join('|')}`);
    if ('impact' in item && !(IMPACTS as readonly unknown[]).includes(item['impact'])) out.add(joinPath(path, 'impact'), 'enum', `impact must be one of ${IMPACTS.join('|')}`);
    if ('target' in item) requiredText(item, 'target', path, out);
  });
}

function checkConstraints(value: unknown, out: IssueCollector): void {
  if (!isPlainObject(value)) return void out.add('constraints', 'required', 'constraints must be an object');
  rejectUnknownKeys(value, ['time_limit', 'network_allowlist', 'fs_scope', 'publish_scope', 'data_classes'], 'constraints', out);
  if ('time_limit' in value) requiredText(value, 'time_limit', 'constraints', out);
  if ('network_allowlist' in value) {
    const path = 'constraints.network_allowlist';
    checkStringList(value['network_allowlist'], path, out, { required: true });
    if (Array.isArray(value['network_allowlist'])) {
      value['network_allowlist'].forEach((entry: unknown, index) => {
        if (typeof entry === 'string' && entry.trim() === '*') out.add(joinPath(path, index), 'wildcard', 'network_allowlist must be explicit domains; "*" (allow all) is forbidden');
      });
    }
  }
  if ('fs_scope' in value) checkStringList(value['fs_scope'], 'constraints.fs_scope', out, { required: true });
  if ('publish_scope' in value && !(SCOPES as readonly unknown[]).includes(value['publish_scope'])) {
    out.add('constraints.publish_scope', 'enum', `publish_scope must be one of ${SCOPES.join('|')}`);
  }
  if ('data_classes' in value) {
    checkStringList(value['data_classes'], 'constraints.data_classes', out, { required: true });
    if (Array.isArray(value['data_classes'])) {
      value['data_classes'].forEach((entry: unknown, index) => {
        if (typeof entry === 'string' && !(SENSITIVITIES as readonly string[]).includes(entry)) {
          out.add(joinPath('constraints.data_classes', index), 'enum', `data class must be one of ${SENSITIVITIES.join('|')}`);
        }
      });
    }
  }
}

function checkAcceptanceCriteria(value: unknown, out: IssueCollector): void {
  if (!Array.isArray(value) || value.length === 0) {
    return void out.add('acceptance_criteria', 'required', 'acceptance_criteria must be a non-empty array');
  }
  checkStringList(value, 'acceptance_criteria', out, { required: true });
}

function checkValidation(value: unknown, out: IssueCollector): void {
  if (!isPlainObject(value)) return void out.add('validation', 'required', 'validation must be {deterministic, llm, human}');
  rejectUnknownKeys(value, ['deterministic', 'llm', 'human'], 'validation', out);
  checkStringList(value['deterministic'], 'validation.deterministic', out, { required: true });
  if (typeof value['human'] !== 'boolean') out.add('validation.human', 'type', 'validation.human must be a boolean');
  const llm = value['llm'];
  if (llm === undefined) {
    out.add('validation.llm', 'required', 'validation.llm must be an object or null');
  } else if (llm !== null) {
    if (!isPlainObject(llm)) {
      out.add('validation.llm', 'type', 'validation.llm must be an object or null');
    } else {
      rejectUnknownKeys(llm, ['check', 'isolated_context'], 'validation.llm', out);
      requiredText(llm, 'check', 'validation.llm', out);
      if ('isolated_context' in llm && typeof llm['isolated_context'] !== 'boolean') {
        out.add('validation.llm.isolated_context', 'type', 'isolated_context must be a boolean');
      }
    }
  }
  const deterministic = value['deterministic'];
  const noDeterministic = Array.isArray(deterministic) && deterministic.length === 0;
  if (noDeterministic && llm === null && value['human'] === false) {
    out.add('validation', 'no_method', 'at least one validation method is required (deterministic checks, an LLM check, or human review)');
  }
}

function checkCostBudget(value: unknown, out: IssueCollector): void {
  if (!isPlainObject(value)) return void out.add('cost_budget', 'required', 'cost_budget must be {max_usd, max_tokens?}');
  rejectUnknownKeys(value, ['max_usd', 'max_tokens'], 'cost_budget', out);
  const usd = value['max_usd'];
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) out.add('cost_budget.max_usd', 'type', 'max_usd must be a finite number >= 0');
  if ('max_tokens' in value) {
    const tokens = value['max_tokens'];
    if (typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens <= 0) out.add('cost_budget.max_tokens', 'type', 'max_tokens must be a positive integer');
  }
}

function checkStringList(
  value: unknown, path: string, out: IssueCollector, options: { required: boolean; nonEmpty?: boolean },
): void {
  if (value === undefined) {
    if (options.required) out.add(path, 'required', `${path} must be an array of strings`);
    return;
  }
  if (!Array.isArray(value)) return void out.add(path, 'type', `${path} must be an array of strings`);
  if (options.nonEmpty && value.length === 0) out.add(path, 'required', `${path} must not be empty`);
  value.forEach((item: unknown, index) => {
    if (!isNonBlankString(item)) out.add(joinPath(path, index), 'type', 'must be a non-empty string');
  });
}
