// 전화 통합 시험 공용: 실제 정책 게이트·승인 엔진·업무 엔진·평가기·게이트웨이 + 가짜 전화 provider. 실제 전화·네트워크는 없다.
import { createFakeAgentAdapter, createFakePhoneProvider, type AgentAdapter, type FakeAdapterConfig, type FakePhoneProvider, type FakeWireEvent, type ToolCallRecord } from '@aot/agent-runtime';
import { SEED_IDS } from '@aot/domain';
import { claimNextTask } from '@aot/task-engine';
import type { InboundRoute } from '@aot/domain';
import type { InboundTaskFactory } from '@aot/agent-runtime';
import { join } from 'node:path';

import { assembleDaemon, type Daemon } from '../../apps/daemon/src/assemble.ts';
import { manualTimers, taskStatus } from './engine.ts';
import { FakeFetcher } from './evaluation.ts';
import { ManualGatewayTimers } from './gateway-contract.ts';
import { FROM, OUR_NUMBER, TO } from './phone.ts';
import { AGENT, approve, createWithGate, deployDirect, HOUR, OWNER, policyEnv, policyText, type PolicyEnv } from './policy.ts';
import { minimalDraft } from './spec-fixtures.ts';

export const TRANSFER_TO = '+82200000009';

export const PHONE_SECTION = `
phone:
  allowed_regions: ["+82"]
  denied_numbers: ["+821000000099"]
  caller_ids: ["${FROM}"]
  max_duration_seconds: 600
  max_calls_per_day: 5
  recording: allowed
  transfer_targets: ["${TRANSFER_TO}"]
`;

export const withPhoneSection = (section = PHONE_SECTION): string => policyText((yaml) => `${yaml}${section}`);

/** 전화 업무 명세. 대상(target)을 주면 그 번호만 걸 수 있다(사람이 승인한 명세의 범위) */
export function phoneTaskSpec(overrides: Record<string, unknown> = {}, targets: { call?: string; transfer?: string } = { call: TO }): Record<string, unknown> {
  return {
    ...minimalDraft(),
    role: 'generalist',
    objective: '잠재 고객에게 전화해 제품 도입 의향을 확인한다',
    inputs: [{ name: 'lead', ref: 'lead:lead_123', kind: 'lead' }],
    allowed_tools: [
      { tool: 'phone_call', operations: ['call'], scope: 'customer', impact: 'external_effect', ...(targets.call === undefined ? {} : { target: targets.call }) },
      ...(targets.transfer === undefined ? [] : [{ tool: 'phone_transfer', operations: ['transfer'], scope: 'customer', impact: 'external_effect', target: targets.transfer }]),
    ],
    constraints: { time_limit: '30m', publish_scope: 'customer' },
    acceptance_criteria: ['고객과 통화가 연결되어 끝났다', '통화 기록이 있다', '구조화된 통화 결과가 기록되었다'],
    validation: { deterministic: ['call_completed', 'call_transcript_present', 'call_outcome_recorded', 'policy_compliance'], llm: null, human: false },
    expected_call_outcome: { dispositions: ['qualified', 'not_interested', 'callback_requested'], required_fields: ['budgetKnown'] },
    ...overrides,
  };
}

export const CALL_ARGS = { to: TO, objective: 'qualify_lead', context: { leadId: 'lead_123', companyName: 'Example Corp' }, constraints: { maxDurationSeconds: 600, allowTransfer: true } };

export interface PhoneRig {
  env: PolicyEnv;
  daemon: Daemon;
  port: FakePhoneProvider;
  records: ToolCallRecord[];
  /** 한 번 tick (업무 하나 집어 실행 + 검증) */
  tick(): ReturnType<Daemon['worker']['tick']>;
  /** provider 가 webhook 을 보낸 것처럼 처리한다 */
  webhook(events: FakeWireEvent[], wantsDirective?: boolean): ReturnType<NonNullable<Daemon['phone']>['ingest']>;
}

export interface PhoneRigOptions {
  /** 기본 정책(전화 섹션 포함) 대신 쓸 정책 텍스트 */
  policy?: string;
  adapter?: AgentAdapter;
  adapterConfig?: Partial<FakeAdapterConfig>;
  routes?: InboundRoute[];
  createInboundTask?: InboundTaskFactory;
  port?: FakePhoneProvider;
}

export function phoneRig(env: PolicyEnv, options: PhoneRigOptions = {}): PhoneRig {
  deployDirect(env, options.policy ?? withPhoneSection());
  const port = options.port ?? createFakePhoneProvider();
  const records: ToolCallRecord[] = [];
  const adapter = options.adapter ?? createFakeAgentAdapter({
    clock: env.clock, scenario: 'tool_calls', toolCalls: [{ tool: 'phone_call', args: CALL_ARGS }],
    result: { summary: '고객과 통화했고 관심이 있다고 했습니다. qualified = true' }, ...options.adapterConfig,
  });
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    evaluation: { fetcher: new FakeFetcher() },
    agent: { adapter, timers: new ManualGatewayTimers(), recorder: { record: (record) => void records.push(record) } },
    phone: {
      port,
      ...(options.routes === undefined ? {} : { inboundRoutes: options.routes }),
      ...(options.createInboundTask === undefined ? {} : { createInboundTask: options.createInboundTask }),
    },
  });
  return {
    env, daemon, port, records,
    tick: () => daemon.worker.tick(),
    webhook: (events, wantsDirective = false) => daemon.phone!.ingest(port.webhook(events, { wantsDirective })),
  };
}

/** 업무를 만들고, 실행 직전 정책 재검증이 승인을 요구해 needs_review 로 보낸 뒤, 사람이 승인·해제해 실행 가능(queued)하게 한다 */
export function createApprovedTask(env: PolicyEnv, spec: Record<string, unknown> = phoneTaskSpec()): string {
  const id = createWithGate(env, spec);
  const claim = claimNextTask(env.db, { clock: env.clock, gate: env.gate, workerId: 'w0', actorId: AGENT, adapter: 'fake-adapter', leaseMs: 90_000, taskId: id });
  if (claim.claimed !== null || taskStatus(env.db, id) !== 'needs_review') throw new Error('expected the task to wait for approval');
  if (!approve(env, id).ok) throw new Error('approval failed');
  env.clock.advance(HOUR);
  const released = env.send({ cmd: 'release', actor: OWNER, kind: 'task', id, totp: env.code() });
  if (!released.ok) throw new Error(`release failed: ${JSON.stringify(released)}`);
  return id;
}

export { OUR_NUMBER, SEED_IDS, taskStatus, policyEnv, TO };
