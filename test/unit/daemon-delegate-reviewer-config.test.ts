// 데몬 설정 `delegate_reviewer` 의 구독 CLI 검토자: 설정 읽기, "쓸 수 없음" 오류 바꾸기, 위임 주기와 이어 돌기 (가짜 프로세스 포트, 가짜 엔진).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { createClaudeCodeGate, type ClaudeCodeConsent } from '@aot/agent-runtime';
import { FakeClock } from '@aot/domain';
import type { ApprovalEngine } from '@aot/policy';

import { createDelegateCycle, DelegateReviewFailedError, DelegateReviewerUnavailableError, type DelegateReviewer } from '../../apps/daemon/src/delegate-cycle.ts';
import { buildClaudeDelegateReviewer, parseDelegateReviewerSetting } from '../../apps/daemon/src/delegate-reviewer-config.ts';
import type { ClaudeCodeCliConfig } from '../../apps/daemon/src/runtime-config.ts';
import { assistantEvent, rateLimitEvent, resultEvent, toLines, toolUseEvent, verifierInit } from '../support/claude-stream.ts';
import { HASH, reviewMaterial } from '../support/delegate-material.ts';
import { FakeDocker } from '../support/fake-docker.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import { makeTempDir } from '../support/temp.ts';

const CLAUDE_CONFIG: ClaudeCodeCliConfig = { claude_path: '/opt/example/bin/claude', run_root: '/tmp/unused', env: { home: '/home/example-daemon', user: 'example-daemon', path: '/usr/bin:/bin' } };
const CONSENT: ClaudeCodeConsent = { notice_version: 'notice-1', accepted_at: '2026-10-26T00:00:00.000Z' };
const START_ISO = '2026-10-26T01:00:00.000Z';
const CLAUDE = { claude: CLAUDE_CONFIG };

describe('delegate_reviewer 설정 (claude_code_cli)', () => {
  it('기본값: model sonnet, 나머지는 생략', () => {
    assert.deepEqual(parseDelegateReviewerSetting({ kind: 'claude_code_cli' }, CLAUDE), { kind: 'claude_code_cli', model: 'sonnet' });
    assert.deepEqual(parseDelegateReviewerSetting({ kind: 'claude_code_cli', model: 'opus[1m]', timeout_ms: 90_000, assumed_cost_usd: 0 }, CLAUDE), { kind: 'claude_code_cli', model: 'opus[1m]', timeout_ms: 90_000, assumed_cost_usd: 0 });
    assert.equal(parseDelegateReviewerSetting(undefined, CLAUDE), undefined);
    assert.equal(parseDelegateReviewerSetting(null, { claude: undefined }), undefined);
  });

  it('모르는 키·나쁜 값·나쁜 모델 이름은 거부한다', () => {
    const bad: unknown[] = [
      'claude_code_cli', [], { kind: 'claude_code_cli', extra: 1 }, { kind: 'claude_code_cli', model: '--help' }, { kind: 'claude_code_cli', model: 5 }, { kind: 'claude_code_cli', model: '' },
      { kind: 'claude_code_cli', timeout_ms: 0 }, { kind: 'claude_code_cli', timeout_ms: 1.5 }, { kind: 'claude_code_cli', timeout_ms: 2 ** 31 },
      { kind: 'claude_code_cli', assumed_cost_usd: -1 }, { kind: 'claude_code_cli', assumed_cost_usd: Number.NaN }, { kind: 'claude_code_cli', assumed_cost_usd: '0.1' },
      { kind: 'claude' },
    ];
    for (const value of bad) assert.throws(() => parseDelegateReviewerSetting(value, CLAUDE), /delegate_reviewer/, JSON.stringify(value));
  });

  it('데몬의 claude_code_cli 설정이 없으면 거부한다', () => {
    assert.throws(() => parseDelegateReviewerSetting({ kind: 'claude_code_cli' }, { claude: undefined }), /needs claude_code_cli/);
  });

  it('stub 은 allowStub 없이는 여전히 거부된다', () => {
    assert.throws(() => parseDelegateReviewerSetting({ kind: 'stub' }, CLAUDE), /test-only/);
    assert.deepEqual(parseDelegateReviewerSetting({ kind: 'stub', verdict: 'escalate' }, { ...CLAUDE, allowStub: true }), { kind: 'stub', verdict: 'escalate' });
  });
});

interface Rig {
  docker: FakeDocker;
  reviewer: DelegateReviewer;
  /** 다음 프로세스가 뜨면 이 줄들을 내보내고 닫는다 */
  answerNext(events: readonly object[], exitCode?: number): void;
}

function rig(t: TestContext, options: { consent?: ClaudeCodeConsent | null } = {}): Rig {
  const docker = new FakeDocker();
  const clock = new FakeClock(START_ISO);
  const runRoot = join(makeTempDir(t, 'aot-ccd-'), 'runs');
  const reviewer = buildClaudeDelegateReviewer({ kind: 'claude_code_cli', model: 'sonnet' }, {
    claude: { ...CLAUDE_CONFIG, run_root: runRoot }, clock, gate: createClaudeCodeGate({ clock }), consent: () => (options.consent === undefined ? CONSENT : options.consent),
    timers: new ManualGatewayTimers(), process: docker, log: () => undefined,
  });
  const answerNext: Rig['answerNext'] = (events, exitCode = 0) => {
    const before = docker.spawned.length;
    void (async () => {
      const deadline = Date.now() + 3000;
      while (docker.spawned.length <= before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
      const proc = docker.spawned[before]!.proc;
      proc.emitStdout(toLines(events as never));
      proc.emitClose(exitCode);
    })();
  };
  return { docker, reviewer, answerNext };
}

const modelStream = (structured: unknown): object[] => [verifierInit(), rateLimitEvent(), toolUseEvent('m1', 'StructuredOutput', {}), assistantEvent('m2', 'done'), resultEvent({ structured: structured as never, totalCostUsd: 0.07 })];

describe('delegate_reviewer 어댑터 (데몬 포트)', () => {
  it('동의가 없으면 agent-runtime 오류가 데몬의 DelegateReviewerUnavailableError 로 바뀐다', async (t) => {
    const r = rig(t, { consent: null });
    await assert.rejects(r.reviewer.review({ taskId: 't', hash: HASH, material: reviewMaterial() }), (e: unknown) => e instanceof DelegateReviewerUnavailableError && /consent_required/.test(e.message));
    assert.equal(r.docker.spawned.length, 0);
  });

  it('프로세스가 시작된 뒤의 실패는 DelegateReviewFailedError 로 비용을 달고 나간다 (주기가 비용 한도에 센다)', async (t) => {
    const r = rig(t);
    r.answerNext([verifierInit(), resultEvent({ isError: true, result: 'boom', terminalReason: 'api_error', structured: null })], 1);
    await assert.rejects(r.reviewer.review({ taskId: 't', hash: HASH, material: reviewMaterial() }), (e: unknown) => e instanceof DelegateReviewFailedError && e.costUsd > 0);
  });
});

/** 위임 주기가 쓰는 엔진 메서드만 가진 가짜. 기록된 결정을 모은다 */
function fakeEngine(): { engine: ApprovalEngine; decisions: Array<{ task_id: string; hash: string; verdict: string; reason: string; cost_usd?: number }> } {
  const decisions: Array<{ task_id: string; hash: string; verdict: string; reason: string; cost_usd?: number }> = [];
  const engine = {
    releaseDelegated: () => [],
    delegationScan: () => (decisions.length > 0 ? [] : [{ taskId: 'task-1', hash: HASH, eligibility: { eligible: true }, review: reviewMaterial() }]),
    delegateDecide: (input: { task_id: string; hash: string; verdict: string; reason: string; cost_usd?: number }) => { decisions.push(input); return { ok: true }; },
  } as unknown as ApprovalEngine;
  return { engine, decisions };
}

describe('위임 주기와 구독 CLI 검토자', () => {
  it('모델이 {verdict, reason} 만 내면 해시가 붙어 delegateDecide 가 approve 로 불린다', async (t) => {
    const r = rig(t);
    const { engine, decisions } = fakeEngine();
    r.answerNext(modelStream({ verdict: 'approve', reason: '기준에 맞습니다' }));
    const report = await createDelegateCycle({ engine, reviewer: r.reviewer }).advance();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.verdict, 'approve');
    assert.equal(decisions[0]!.hash, HASH);
    assert.equal(decisions[0]!.cost_usd, 0.07);
    assert.deepEqual(report.decided, [{ taskId: 'task-1', verdict: 'approve', outcome: 'recorded' }]);
  });

  it('모델이 추가 키를 내면 해시가 붙지 않아 사람에게 넘어간다 (escalate)', async (t) => {
    const r = rig(t);
    const { engine, decisions } = fakeEngine();
    r.answerNext(modelStream({ verdict: 'approve', reason: 'ok', note: 'x' }));
    await createDelegateCycle({ engine, reviewer: r.reviewer }).advance();
    assert.equal(decisions[0]!.verdict, 'escalate');
    assert.match(decisions[0]!.reason, /AI 응답 형식 오류/);
  });

  it('검토자를 쓸 수 없으면 기록 없이 건너뛴다', async (t) => {
    const r = rig(t, { consent: null });
    const { engine, decisions } = fakeEngine();
    const report = await createDelegateCycle({ engine, reviewer: r.reviewer }).advance();
    assert.equal(decisions.length, 0);
    assert.equal(report.unavailable, 1);
  });
});

describe('위임 주기: 실패한 검토', () => {
  it('실패는 review_failed 로 표시하고 든 비용을 넘긴다 (비용을 모르는 일반 오류는 0)', async () => {
    for (const [error, cost] of [[new DelegateReviewFailedError('시간 초과', 0.07), 0.07], [new Error('boom'), 0]] as const) {
      const { engine, decisions } = fakeEngine();
      const reviewer: DelegateReviewer = { id: 'f', review: () => Promise.reject(error) };
      await createDelegateCycle({ engine, reviewer }).advance();
      assert.deepEqual(decisions.map((d) => [d.verdict, d.cost_usd, (d as { review_failed?: boolean }).review_failed]), [['escalate', cost, true]]);
    }
  });

  it('형식 오류도 review_failed 이고, 정상 판정은 아니다', async () => {
    const { engine, decisions } = fakeEngine();
    const reviewer: DelegateReviewer = { id: 'f', review: () => Promise.resolve({ output: { verdict: 'maybe' }, costUsd: 0.02 }) };
    await createDelegateCycle({ engine, reviewer }).advance();
    assert.deepEqual(decisions.map((d) => [d.verdict, d.cost_usd, (d as { review_failed?: boolean }).review_failed]), [['escalate', 0.02, true]]);
    const ok = fakeEngine();
    await createDelegateCycle({ engine: ok.engine, reviewer: { id: 'o', review: (request) => Promise.resolve({ output: { verdict: 'approve', hash: request.hash, reason: '기준에 맞습니다' } }) } }).advance();
    assert.equal((ok.decisions[0] as { review_failed?: boolean }).review_failed, undefined);
  });
});
