// 데몬 설정 `delegate_reviewer` 의 모델 검토자 (ADR-0016, docs/plans/delegate-reviewer.md §4).
//  `{"kind": "claude_code_cli", "model"?: "sonnet", "timeout_ms"?: 정수, "assumed_cost_usd"?: 0 이상 수}`
//  - 구독 `claude` CLI 를 도구 없이 불러 판정을 받는다. 실행 파일·run_root·환경은 데몬의 `claude_code_cli` 설정을 그대로 쓰고, 동의·게이트도 실행 어댑터·검증기와 같은 것이다(구독 풀이 하나다).
//  - `{"kind": "stub"}` 는 기존 `parseDelegateReviewerConfig` 가 맡는다(시험 전용: `allowStub` 없이는 거부).
import { createClaudeCodeDelegateReviewer, DelegateReviewerRunError, DelegateReviewerUnavailable, MODEL_NAME, type ClaudeCodeConsent, type ClaudeCodeGate, type GatewayTimers, type ProcessPort } from '@aot/agent-runtime';
import type { Clock } from '@aot/domain';

import { DelegateReviewFailedError, DelegateReviewerUnavailableError, parseDelegateReviewerConfig, type DelegateReviewer, type DelegateReviewerConfig } from './delegate-cycle.ts';
import type { ClaudeCodeCliConfig } from './runtime-config.ts';

export const DEFAULT_DELEGATE_REVIEWER_MODEL = 'sonnet';
const MAX_TIMEOUT_MS = 3_600_000;
const CLAUDE_KEYS: ReadonlySet<string> = new Set(['kind', 'model', 'timeout_ms', 'assumed_cost_usd']);

/** 구독 CLI 위임 검토자 설정 (읽은 뒤: 기본값 채움) */
export interface ClaudeDelegateReviewerConfig {
  kind: 'claude_code_cli';
  model: string;
  timeout_ms?: number;
  assumed_cost_usd?: number;
}

export type DelegateReviewerSetting = DelegateReviewerConfig | ClaudeDelegateReviewerConfig;

/**
 * `delegate_reviewer` 설정을 읽는다. 없으면(undefined·null) undefined. `claude_code_cli` 종류는 데몬의 `claude_code_cli` 설정(`claude`)이 있어야 한다.
 * stub 은 `allowStub` 이 있을 때만 읽힌다(운영 조립은 주지 않는다).
 */
export function parseDelegateReviewerSetting(value: unknown, context: { claude: ClaudeCodeCliConfig | undefined; allowStub?: boolean }): DelegateReviewerSetting | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('delegate_reviewer must be an object like {"kind": "claude_code_cli", "model": "sonnet"}');
  const record = value as Record<string, unknown>;
  if (record['kind'] !== 'claude_code_cli') return parseDelegateReviewerConfig(value, context.allowStub === true ? { allowStub: true } : {});
  const unknown = Object.keys(record).filter((key) => !CLAUDE_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`delegate_reviewer has unknown key(s): ${unknown.join(', ')}`);
  if (context.claude === undefined) throw new Error('delegate_reviewer (kind "claude_code_cli") needs claude_code_cli (it uses the same login, consent and usage gate)');
  const model = record['model'] === undefined ? DEFAULT_DELEGATE_REVIEWER_MODEL : record['model'];
  if (typeof model !== 'string' || !MODEL_NAME.test(model)) throw new Error('delegate_reviewer.model must be a model alias or id (letters, digits and . _ : [ ] -)');
  const timeout = record['timeout_ms'];
  if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS)) throw new Error(`delegate_reviewer.timeout_ms must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  const cost = record['assumed_cost_usd'];
  if (cost !== undefined && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) throw new Error('delegate_reviewer.assumed_cost_usd must be a finite number >= 0');
  return { kind: 'claude_code_cli', model, ...(timeout === undefined ? {} : { timeout_ms: timeout }), ...(cost === undefined ? {} : { assumed_cost_usd: cost }) };
}

export interface ClaudeDelegateReviewerDeps {
  claude: ClaudeCodeCliConfig;
  clock: Clock;
  /** 실행 어댑터·검증기와 *같은* 게이트 */
  gate: ClaudeCodeGate;
  /** 실행 어댑터·검증기와 같은 동의 기록 읽기 (`() => readClaudeCodeConsent(db)`) */
  consent: () => ClaudeCodeConsent | null;
  timers?: GatewayTimers;
  /** 시험이 가짜 프로세스 포트를 넣는다 */
  process?: ProcessPort;
  log?: (message: string) => void;
}

/** 구독 CLI 검토자를 만든다. agent-runtime 의 "쓸 수 없음" 오류는 주기가 아는 `DelegateReviewerUnavailableError` 로 바꿔 던진다 */
export function buildClaudeDelegateReviewer(setting: ClaudeDelegateReviewerConfig, deps: ClaudeDelegateReviewerDeps): DelegateReviewer {
  const inner = createClaudeCodeDelegateReviewer({
    claudePath: deps.claude.claude_path, runRoot: deps.claude.run_root, env: deps.claude.env, consent: deps.consent, clock: deps.clock, gate: deps.gate, model: setting.model,
    ...(setting.timeout_ms === undefined ? {} : { timeLimitMs: setting.timeout_ms }),
    ...(setting.assumed_cost_usd === undefined ? {} : { assumedCostUsd: setting.assumed_cost_usd }),
    ...(deps.timers === undefined ? {} : { timers: deps.timers }),
    ...(deps.process === undefined ? {} : { process: deps.process }),
    log: deps.log ?? ((message) => console.error(`claude delegate reviewer: ${message}`)),
  });
  return {
    id: inner.id,
    review: async (request) => {
      try {
        return await inner.review(request);
      } catch (error) {
        if (error instanceof DelegateReviewerUnavailable) throw new DelegateReviewerUnavailableError(error.message);
        // 프로세스가 시작된 뒤의 실패는 비용을 그대로 주기에 넘긴다 (하루 검토 비용 한도에 세기 위해)
        if (error instanceof DelegateReviewerRunError) throw new DelegateReviewFailedError(error.message, error.costUsd);
        throw error;
      }
    },
  };
}
