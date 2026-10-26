// 상품 등록 검증 업무의 평가를 데몬 조립(실제 정책 게이트 + 업무 엔진 + 평가기)에서 끝까지:
//  - 호스트가 저장한 근거 본문(가짜 EvidenceReader)을 평가기가 직접 읽어 결정론적 검사 5개와 LLM 검증을 통과하면 pass → (validation.human) needs_review
//  - 근거 읽기 포트가 없으면 읽어야 하는 검사가 unknown → inconclusive → needs_review (조용히 통과하지 않는다)
//  - 검증기를 지금은 쓸 수 없으면(VerifierUnavailableError) 평가를 기록하지 않고 업무는 validating 에 남아 다음 tick 에 다시 검증된다. 일반 오류는 unclear → inconclusive
// 외부 접근은 없다(가짜 검증기·가짜 근거 저장소).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { VerifierUnavailableError, type IsolatedVerificationInput, type LlmVerdict, type LlmVerifier } from '@aot/evaluation';
import type { RunContext, TaskExecutor } from '@aot/task-engine';

import { assembleDaemon } from '../../apps/daemon/src/assemble.ts';
import { manualTimers, taskStatus } from '../support/engine.ts';
import { evaluationsOf, FakeFetcher, validationSpec } from '../support/evaluation.ts';
import { AGENT, createWithGate, policyEnv, readOnlyDraft, type PolicyEnv } from '../support/policy.ts';
import { IDS, putRegistrationEvidence, registrationFixture, registrationReport } from '../support/registration.ts';

const CHECKS = ['schema_valid', 'evidence_refs_resolvable', 'no_secret_in_outputs', 'read_only_calls_only', 'scan_coverage_complete', 'classification_present', 'budget'];

/** 호출마다 시나리오가 정한 대로 답하는 검증기 */
class ScriptedLlm implements LlmVerifier {
  readonly id = 'scripted-verifier@v1';
  readonly inputs: IsolatedVerificationInput[] = [];
  readonly #steps: (() => LlmVerdict)[];

  constructor(...steps: (() => LlmVerdict)[]) {
    this.#steps = steps;
  }

  verify(input: IsolatedVerificationInput): Promise<LlmVerdict> {
    this.inputs.push(input);
    const step = this.#steps[Math.min(this.inputs.length - 1, this.#steps.length - 1)]!;
    try {
      return Promise.resolve(step());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

const supported = (): LlmVerdict => ({ verdict: 'supported', note: 'all claims are supported by the stored evidence' });

function rig(env: PolicyEnv, options: { llm: LlmVerifier; reader?: boolean }) {
  const fixture = registrationFixture(env.db, env.clock);
  const executor: TaskExecutor = {
    execute: (ctx: RunContext) => {
      putRegistrationEvidence(fixture, { taskId: ctx.taskId, runId: ctx.lease.runId });
      return Promise.resolve({ result: registrationReport() });
    },
  };
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, adapter: 'fake-adapter', executor, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    evaluation: { fetcher: new FakeFetcher(), llm: options.llm, ...(options.reader === false ? {} : { evidenceReader: fixture.reader }) },
  });
  const taskId = createWithGate(env, readOnlyDraft({
    ...validationSpec(CHECKS, { llm: { check: 'summary_supported_by_evidence', isolated_context: true }, human: true }),
    inputs: [{ name: 'k', ref: 'r:registration', kind: 'k' }],
  }));
  return { daemon, taskId };
}

test('stored evidence read by the evaluator: all checks and the LLM verification pass, then the human reviews (needs_review)', async (t) => {
  const env = policyEnv(t);
  const llm = new ScriptedLlm(supported);
  const { daemon, taskId } = rig(env, { llm });
  await daemon.worker.tick(); // 실행
  const checked = await daemon.worker.tick(); // 검증
  assert.deepEqual(checked.validated.map((v) => v.taskStatus), ['needs_review'], 'validation.human sends a passing task to a person');
  const [evaluation] = evaluationsOf(env.db, taskId);
  assert.equal(evaluation?.outcome, 'pass', JSON.stringify(env.db.get('SELECT quality_note FROM evaluation WHERE task_id = ?', [taskId])));
  assert.equal(evaluation?.safety, 'pass');

  // 검증기는 근거 본문을 원본으로 받는다: 주장마다 근거 행, 본문, 해시, 신뢰 출처(행이 밝힌 값 그대로)
  const [input] = llm.inputs;
  assert.deepEqual(input?.claims.map((claim) => [claim.id, claim.sourceRef]), [['c1', `evidence:${IDS.structure}`], ['c2', `evidence:${IDS.readme}`]]);
  assert.deepEqual(input?.sources.map((source) => [source.ref, source.trustOrigin, source.text !== null]), [
    [`evidence:${IDS.structure}`, 'internal', true], [`evidence:${IDS.readme}`, 'external_untrusted', true],
  ]);
  assert.ok(input?.sources.every((source) => source.contentHash !== null));
  // 근거 행은 확인됨으로 표시되고 보고서 사용 여부가 남는다
  const verified = env.db.all<{ id: string; verified: number }>('SELECT id, verified FROM evidence WHERE task_id = ? ORDER BY id', [taskId]);
  assert.deepEqual(verified.map((row) => row.verified), verified.map(() => 1));
  assert.equal(env.db.get('SELECT agent_report_used AS used FROM evaluation WHERE task_id = ?', [taskId])?.['used'], 1);
});

test('an LLM verdict of unsupported fails the evaluation; the stored evidence was still the source', async (t) => {
  const env = policyEnv(t);
  const { daemon, taskId } = rig(env, { llm: new ScriptedLlm(() => ({ verdict: 'unsupported', note: 'claim c2 is not in the README' })) });
  await daemon.worker.tick();
  const checked = await daemon.worker.tick();
  assert.deepEqual(checked.validated.map((v) => v.taskStatus), ['retry_wait']);
  assert.equal(evaluationsOf(env.db, taskId)[0]?.outcome, 'fail');
});

test('without an evidence reader the content checks are unknown and the evaluation is inconclusive (needs_review), with no claim sent to the verifier', async (t) => {
  const env = policyEnv(t);
  const llm = new ScriptedLlm(supported);
  const { daemon, taskId } = rig(env, { llm, reader: false });
  await daemon.worker.tick();
  const checked = await daemon.worker.tick();
  assert.deepEqual(checked.validated.map((v) => v.taskStatus), ['needs_review']);
  assert.equal(evaluationsOf(env.db, taskId)[0]?.outcome, 'inconclusive');
  assert.equal(llm.inputs.length, 0, 'the LLM step is skipped while the deterministic checks are not all passing');
});

test('a verifier that is unavailable right now leaves the task in validating with no evaluation written; the next tick verifies it', async (t) => {
  const env = policyEnv(t);
  const llm = new ScriptedLlm(
    () => { throw new VerifierUnavailableError('usage_limit', 'the subscription usage limit was reached'); },
    () => { throw new VerifierUnavailableError('usage_deferred', 'yielding to the person'); },
    supported,
  );
  const { daemon, taskId } = rig(env, { llm });
  await daemon.worker.tick(); // 실행
  const first = await daemon.worker.tick();
  assert.deepEqual(first.validated, []);
  assert.deepEqual(first.validationFailed.map((f) => [f.taskId, f.error]), [[taskId, 'usage_limit: the subscription usage limit was reached']]);
  assert.equal(taskStatus(env.db, taskId), 'validating');
  assert.deepEqual(evaluationsOf(env.db, taskId), [], 'nothing is recorded while the verifier is unavailable');
  assert.equal(env.db.get('SELECT COUNT(*) AS n FROM evidence WHERE task_id = ? AND verified = 1', [taskId])?.['n'], 0, 'no half-applied verification either');

  const second = await daemon.worker.tick();
  assert.equal(second.validationFailed.length, 1);
  assert.equal(taskStatus(env.db, taskId), 'validating');

  const third = await daemon.worker.tick();
  assert.deepEqual(third.validated.map((v) => v.taskStatus), ['needs_review']);
  assert.equal(evaluationsOf(env.db, taskId)[0]?.outcome, 'pass');
  assert.equal(llm.inputs.length, 3);
});

test('any other verifier error is the model failing to decide: unclear, inconclusive, a person reviews (unchanged behaviour)', async (t) => {
  const env = policyEnv(t);
  const { daemon, taskId } = rig(env, { llm: new ScriptedLlm(() => { throw new Error('the model returned garbage'); }) });
  await daemon.worker.tick();
  const checked = await daemon.worker.tick();
  assert.deepEqual(checked.validated.map((v) => v.taskStatus), ['needs_review']);
  assert.equal(evaluationsOf(env.db, taskId)[0]?.outcome, 'inconclusive');
  assert.match(String(env.db.get('SELECT quality_note FROM evaluation WHERE task_id = ?', [taskId])?.['quality_note']), /LLM verification failed: the model returned garbage/);
});
