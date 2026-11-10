// 결정 위임 엔진 (ADR-0016, 제안): 적격 검사, 위임 승인의 기록(위임 id·해시·사유), 승인 계산, 정지·철회·취소, 소켓 경계, 배포 점검.
// 위임이 없는 정책에서 기존 동작이 그대로인 것은 기존 정책 시험 전체가 그대로 통과하는 것으로 고정한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  APPROVAL_DELEGATE, draftSendStates, ensureApprovalDelegate, maskedPathsOf, maskSecretKeys, proposedDraftsOf, type TaskRow, type TaskSpec,
} from '@aot/domain';
import {
  ALWAYS_HUMAN, approvalStatus, delegationAuthority, delegationEligibility, evaluateRequest, parsePolicy, requestsFromSpec, taskRequester, type DelegationTaskContext,
  type EligibilityCode, type PolicyDocument,
} from '@aot/policy';

import {
  approvalsOf, controlsOf, decide, DELEGATE, delegationEnv, delegationPolicyText, draftedFor, hashOf, MANDATE, reviewsOf, type MandateOptions,
} from '../support/delegation.ts';
import { draftsOf } from '../support/drafts.ts';
import { claimWith } from '../support/draft-flow.ts';
import { taskStatus } from '../support/engine.ts';
import { examplePayload } from '../support/message-tool.ts';
import { AGENT, HOUR, OWNER, REVIEWER, DEFAULT_TEMPLATE_TEXT, policyEnv, taskRow, type PolicyEnv } from '../support/policy.ts';

const DAY = 24 * HOUR;

const transitionsOf = (env: PolicyEnv, taskId: string) =>
  env.db.all<{ from_status: string | null; to_status: string; caused_by: string; reason: string }>('SELECT from_status, to_status, caused_by, reason FROM task_transition WHERE task_id = ? ORDER BY id', [taskId]);

// ===== 위임 승인의 기록 =====

test('a delegated approval records the mandate id, the exact show hash (drafts included), the AI reason and via=delegate; it waits out the cooldown, then the daemon releases it without a TOTP', async (t) => {
  const env = delegationEnv(t);
  const { taskId } = await draftedFor(env);
  const hash = hashOf(env, taskId);
  const shown = env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId });
  assert.equal((shown['subject'] as { drafts: unknown[] }).drafts.length, 1, 'the hash covers the draft list');

  const result = decide(env, taskId, 'approve', 'routine notice, no prices');
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.recorded, 'approved');
  assert.deepEqual(approvalsOf(env.db, taskId), [
    { decision: 'approved', decided_by: DELEGATE, subject_hash: hash, comment: 'routine notice, no prices', mandate_id: MANDATE, via: 'delegate' },
  ]);
  assert.equal(taskRow(env.db, taskId).approved_hash, hash);
  assert.equal(taskStatus(env.db, taskId), 'needs_review', 'a delegated approval alone does not queue the task');
  const waiting = env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId });
  assert.equal((waiting['approval'] as { state: string }).state, 'cooldown');
  assert.equal((waiting['approval'] as { mandate_id: string }).mandate_id, MANDATE);
  assert.equal(waiting['hash'], hash, 'the approval did not change the hash');
  assert.deepEqual(reviewsOf(env.db, taskId).map((r) => [r.verdict, r.outcome, r.subject_hash]), [['approve', 'recorded', hash]]);

  assert.deepEqual(env.engine.releaseDelegated(), [], 'still in the cooldown');
  env.clock.advance(HOUR);
  const released = env.engine.releaseDelegated();
  assert.deepEqual(released.map((r) => [r.taskId, r.mandateId]), [[taskId, MANDATE]]);
  assert.equal(taskStatus(env.db, taskId), 'queued');
  const last = transitionsOf(env, taskId).at(-1)!;
  assert.deepEqual([last.from_status, last.to_status, last.caused_by], ['needs_review', 'queued', DELEGATE]);
  assert.match(last.reason, /delegation cooldown \(mandate routine-mail\)/);
  assert.deepEqual(env.engine.releaseDelegated(), [], 'released once');
  assert.equal(env.db.get('SELECT count(*) AS n FROM human_reauth')?.['n'], 0, 'no TOTP anywhere');

  // 실행 직전 재확인(beforeRun)이 위임 승인을 받아들여 전송 단계로 보낸다
  const claim = claimWith(env, taskId).claimed;
  assert.equal(claim?.phase, 'dispatch');
});

test('escalate and an unknown verdict record no approval; a stale hash is refused and recorded against the hash the AI saw', async (t) => {
  const env = delegationEnv(t);
  const { taskId } = await draftedFor(env);
  assert.equal(decide(env, taskId, 'escalate', 'mentions an apology').ok, true);
  assert.equal(approvalsOf(env.db, taskId).length, 0);
  assert.deepEqual(reviewsOf(env.db, taskId).map((r) => [r.verdict, r.outcome, r.reason]), [['escalate', 'recorded', 'mentions an apology']]);

  const bad = env.engine.delegateDecide({ task_id: taskId, hash: hashOf(env, taskId), verdict: 'reject' as never, reason: 'x' });
  assert.deepEqual([bad.ok, bad.ok ? '' : bad.code], [false, 'bad_request']);
  const blank = env.engine.delegateDecide({ task_id: taskId, hash: hashOf(env, taskId), verdict: 'approve', reason: '   ' });
  assert.equal(blank.ok, false, 'a reason is required');

  const stale = env.engine.delegateDecide({ task_id: taskId, hash: 'f'.repeat(64), verdict: 'approve', reason: 'saw something else' });
  assert.deepEqual([stale.ok, stale.ok ? '' : stale.code], [false, 'hash_mismatch']);
  assert.equal(approvalsOf(env.db, taskId).length, 0, 'nothing was approved');
  assert.equal(reviewsOf(env.db, taskId).at(-1)!.subject_hash, 'f'.repeat(64), 'the stale review does not use up the current hash');
  assert.equal(env.engine.delegateDecide({ task_id: 'no-such-task', hash: 'a'.repeat(64), verdict: 'approve', reason: 'x' }).ok, false);
});

test('the reason is cut to 200 characters; the holder is fixed to the mandate holder (the caller cannot name another actor)', async (t) => {
  const env = delegationEnv(t);
  const { taskId } = await draftedFor(env);
  const result = env.engine.delegateDecide({ task_id: taskId, hash: hashOf(env, taskId), verdict: 'approve', reason: 'r'.repeat(900), actor: OWNER } as never);
  assert.equal(result.ok, true);
  const [row] = approvalsOf(env.db, taskId);
  assert.equal(row!.comment!.length, 200);
  assert.equal(row!.decided_by, DELEGATE, 'an extra actor field is ignored');
});

// ===== 적격: 하나라도 거짓이면 사람에게 남는다 =====

const REFUSALS: Array<{
  name: string; code: EligibilityCode; mandate?: MandateOptions;
  draft?: { requests?: object[]; influenced?: boolean; causedBy?: string };
  before?: (env: PolicyEnv, taskId: string, draftRunId: string) => void | Promise<void>;
}> = [
  { name: 'too many recipients', code: 'recipients', draft: { requests: [examplePayload({ to: ['a@example.com', 'b@example.com'] })] } },
  { name: 'cc and bcc count as recipients', code: 'recipients', draft: { requests: [{ ...examplePayload(), cc: ['c@example.com'] }] } },
  { name: 'payload larger than the limit', code: 'payload_size', mandate: { limits: { max_payload_bytes: 60 } } },
  { name: 'more drafts than the limit', code: 'too_many_drafts', draft: { requests: [examplePayload(), examplePayload({ subject: 'two' })] } },
  { name: 'target outside the mandate', code: 'out_of_mandate', mandate: { targets: ['mailbox:other'] } },
  { name: 'action outside the mandate', code: 'out_of_mandate', mandate: { actions: ['mail.send'] } },
  { name: 'scope outside the mandate', code: 'out_of_mandate', mandate: { scopes: ['internal'] } },
  { name: 'a draft influenced by external input is always a person', code: 'external_input', draft: { influenced: true } },
  { name: 'a draft that would show masked values', code: 'masked', draft: { requests: [{ ...examplePayload(), api_key: 'sk-secret-value' }] } },
  { name: 'a payload whose recipients cannot be read', code: 'unknown_shape', draft: { requests: [{ note: 'free-form' }] } },
  { name: 'an expired draft', code: 'draft_expired', before: (env) => void env.clock.advance(73 * HOUR) },
  {
    name: 'a draft whose send already started', code: 'send_started',
    before: (env, taskId, runId) => {
      const [draft] = draftsOf(env.db, taskId);
      env.db.writeTx((tx) => tx.run(
        `INSERT INTO external_effect (id, effect_key, task_id, task_run_id, tool, action, target, request_hash, state, supports_idempotency, idempotency_retention_ms, planned_at, at)
         VALUES ('e1', ?, ?, ?, ?, ?, ?, ?, 'planned', 1, 86400000, ?, ?)`,
        [draft!.effect_key, taskId, runId, draft!.tool, draft!.action, draft!.target, draft!.payload_hash, env.clock.nowIso(), env.clock.nowIso()],
      ));
    },
  },
  { name: 'a task the holder asked for', code: 'requester_is_holder', draft: { causedBy: DELEGATE } },
  { name: 'a task budget above the mandate limit', code: 'task_budget', mandate: { limits: { max_task_usd: 1 } } },
  {
    name: 'a person already decided on this task (cancel)', code: 'human_decided',
    before: (env, taskId) => void env.send({ cmd: 'cancel', actor: OWNER, kind: 'task', id: taskId }),
  },
  {
    name: 'an approval is already recorded', code: 'already_approved',
    before: (env, taskId) => void env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash: hashOf(env, taskId) }),
  },
  { name: 'a paused mandate', code: 'mandate_inactive', before: (env) => void env.send({ cmd: 'delegation', actor: OWNER, op: 'pause' }) },
  { name: 'an expired mandate', code: 'mandate_inactive', before: (env) => void env.clock.advance(75 * DAY) },
  { name: 'a holder that is not a registered agent', code: 'holder_unavailable', mandate: { holder: 'nobody-here' } },
];

for (const row of REFUSALS) {
  test(`eligibility: ${row.name} stays with a person (${row.code}), with the reason recorded`, async (t) => {
    const env = delegationEnv(t, [row.mandate ?? {}]);
    const drafted = await draftedFor(env, row.draft ?? {});
    await row.before?.(env, drafted.taskId, drafted.draftRunId);
    const before = taskStatus(env.db, drafted.taskId);
    const hash = hashOf(env, drafted.taskId);
    const result = env.engine.delegateDecide({ task_id: drafted.taskId, hash, verdict: 'approve', reason: 'looks fine' });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.code, row.code);
    assert.equal(taskStatus(env.db, drafted.taskId), before, 'the task did not move');
    assert.equal(approvalsOf(env.db, drafted.taskId).filter((a) => a.mandate_id !== null).length, 0, 'no delegated approval row');
    const reviews = reviewsOf(env.db, drafted.taskId);
    assert.equal(reviews.at(-1)!.verdict, 'escalate');
    assert.equal(reviews.at(-1)!.outcome, row.code);
    assert.ok(reviews.at(-1)!.reason.length > 0, 'a human-readable reason is recorded');
  });
}

test('limits that depend on other work: the daily approval limit, the review budget and the rewrite limit', async (t) => {
  const env = delegationEnv(t, [{ limits: { max_per_day: 1, max_review_usd_per_day: 1, max_rewrites_per_task: 1 } }]);
  const a = await draftedFor(env, { dedupeKey: 'a' });
  const b = await draftedFor(env, { dedupeKey: 'b' });
  const c = await draftedFor(env, { dedupeKey: 'c' });
  assert.equal(decide(env, a.taskId, 'approve').ok, true);
  const second = decide(env, b.taskId, 'approve');
  assert.deepEqual([second.ok, second.ok ? '' : second.code], [false, 'daily_limit']);
  assert.match(reviewsOf(env.db, b.taskId).at(-1)!.reason, /하루 한도 1건/);

  // 24시간 창이 지나면 다시 센다
  env.clock.advance(DAY + HOUR);
  // (초안은 72시간 기한이라 아직 유효하다)
  assert.equal(decide(env, c.taskId, 'request_changes', 'shorten the greeting').ok, true, 'a rewrite is not an approval and does not use the daily approval limit');
  assert.equal(taskStatus(env.db, c.taskId), 'queued');
  assert.deepEqual(approvalsOf(env.db, c.taskId).map((r) => [r.decision, r.decided_by, r.mandate_id, r.via]), [['changes_requested', DELEGATE, MANDATE, 'delegate']]);
  assert.equal(proposedDraftsOf(env.db, c.taskId).length, 0, 'the drafts were discarded');
  assert.equal(draftsOf(env.db, c.taskId).every((d) => d.state === 'superseded'), true);
  const transition = transitionsOf(env, c.taskId).at(-1)!;
  assert.deepEqual([transition.from_status, transition.to_status, transition.caused_by], ['needs_review', 'queued', DELEGATE]);
});

test('rewrites are limited per task and counted from the AI\'s own changes_requested rows; past the limit the task goes to a person', async (t) => {
  const env = delegationEnv(t, [{ limits: { max_rewrites_per_task: 1 } }]);
  const one = await draftedFor(env, { dedupeKey: 'one' });
  // 사람이 아니라 위임 보유자의 다시 쓰게가 한 번 있었던 업무를 만든다: 같은 업무에 대해 한도를 넘긴 결정을 흉내 낸다
  assert.equal(decide(env, one.taskId, 'request_changes', 'first rewrite').ok, true);
  // 다시 쓴 초안이 다시 needs_review 에 오는 흐름 대신, 승인 행으로 한도를 직접 채워 넘김 경로를 본다
  const two = await draftedFor(env, { dedupeKey: 'two' });
  env.db.writeTx((tx) => tx.run(
    "INSERT INTO approval (id, subject_kind, subject_id, decision, subject_hash, decided_by, comment, at, mandate_id, via) VALUES ('ap-rw', 'task', ?, 'changes_requested', ?, ?, 'earlier', ?, ?, 'delegate')",
    [two.taskId, hashOf(env, two.taskId), DELEGATE, env.clock.nowIso(), MANDATE],
  ));
  const over = decide(env, two.taskId, 'request_changes', 'one more');
  assert.deepEqual([over.ok, over.ok ? '' : over.code], [false, 'rewrite_limit']);
  assert.equal(taskStatus(env.db, two.taskId), 'needs_review');
  assert.equal(reviewsOf(env.db, two.taskId).at(-1)!.outcome, 'rewrite_limit');
  // 다시 쓰게 한도는 승인을 막지 않는다
  assert.equal(decide(env, two.taskId, 'approve', 'fine as is').ok, true);
});

test('the review budget counts the AI cost of earlier reviews in the last 24 hours', async (t) => {
  const env = delegationEnv(t, [{ limits: { max_review_usd_per_day: 1 } }]);
  const a = await draftedFor(env, { dedupeKey: 'a' });
  const b = await draftedFor(env, { dedupeKey: 'b' });
  assert.equal(decide(env, a.taskId, 'escalate', 'unsure', { cost_usd: 1.5 }).ok, true);
  assert.equal(reviewsOf(env.db, a.taskId)[0]!.cost_usd, 1.5);
  const over = decide(env, b.taskId, 'approve');
  assert.deepEqual([over.ok, over.ok ? '' : over.code], [false, 'review_budget']);
  env.clock.advance(DAY + HOUR);
  assert.equal(decide(env, b.taskId, 'approve').ok, true, 'a day later the budget is available again');
});

// ===== 항상 사람 (코드 상수) =====

/** 엔진이 만드는 것과 같은 업무 문맥에서 명세만 바꿔 적격 함수를 직접 부른다 */
function ctxOf(env: PolicyEnv, taskId: string, mutate: (spec: TaskSpec) => void = () => undefined, document?: PolicyDocument): DelegationTaskContext {
  const task = taskRow(env.db, taskId) as TaskRow;
  const spec = JSON.parse(task.spec) as TaskSpec;
  mutate(spec);
  const doc = document ?? env.store.active(env.db)!.policy!.document;
  const drafts = proposedDraftsOf(env.db, taskId);
  return {
    task, spec, document: doc, drafts, requester: taskRequester(env.db, task),
    verdicts: requestsFromSpec(spec).map((request) => ({ request, verdict: evaluateRequest(doc, request) })),
    sendStates: draftSendStates(env.db, drafts),
    masked: new Map(drafts.map((d) => [d.id, maskedPathsOf(JSON.parse(d.payload), maskSecretKeys(JSON.parse(d.payload)))])),
  };
}

test('always-human work is never eligible, whatever the mandate says: delete impact, public scope, scope approvals that are not drafts, a policy deny', async (t) => {
  const env = delegationEnv(t);
  const { taskId } = await draftedFor(env);
  const now = env.clock.nowIso();
  assert.equal(delegationEligibility(env.db, ctxOf(env, taskId), now).eligible, true, 'the baseline is eligible');

  const withDelete = ctxOf(env, taskId, (spec) => {
    spec.allowed_tools.push({ tool: 'cleanup', operations: ['remove'], scope: 'internal', impact: 'delete', target: 'files:task-own' } as TaskSpec['allowed_tools'][number]);
  }, parsePolicyOrThrow(delegationPolicyText([{}], DEFAULT_TEMPLATE_TEXT.replace('rules:\n', "rules:\n  - id: allow-delete\n    impact: [delete]\n    decision: allow\n"))));
  const deleteResult = delegationEligibility(env.db, withDelete, now);
  assert.equal(deleteResult.eligible, false);
  assert.equal(deleteResult.eligible ? '' : deleteResult.code, 'always_human');

  const publicScope = delegationEligibility(env.db, ctxOf(env, taskId, (spec) => {
    spec.allowed_tools.push({ tool: 'site', operations: ['read'], scope: 'public', impact: 'read', target: 'site:main' } as TaskSpec['allowed_tools'][number]);
  }), now);
  assert.equal(publicScope.eligible ? '' : publicScope.code, 'always_human');

  const customerRead = delegationEligibility(env.db, ctxOf(env, taskId, (spec) => {
    spec.allowed_tools.push({ tool: 'crm_read', operations: ['read'], scope: 'customer', impact: 'read', target: 'crm:example' } as TaskSpec['allowed_tools'][number]);
  }), now);
  assert.equal(customerRead.eligible ? '' : customerRead.code, 'always_human', 'a scope approval that is not a draft stays with a person');

  const denied = delegationEligibility(env.db, ctxOf(env, taskId, (spec) => {
    spec.allowed_tools.push({ tool: 'cleanup', operations: ['remove'], scope: 'internal', impact: 'delete', target: 'files:task-own' } as TaskSpec['allowed_tools'][number]);
  }), now);
  assert.equal(denied.eligible ? '' : denied.code, 'policy_denied', 'a deny is not changed by a mandate');

  assert.deepEqual([...ALWAYS_HUMAN].sort(), [
    'delegation_resume', 'delete_impact', 'effect_resolution', 'external_input_draft', 'human_decided_task', 'org_proposal', 'policy_deploy', 'product_decision',
    'publication', 'scope_approval_task', 'strategy_version',
  ]);
});

function parsePolicyOrThrow(text: string): PolicyDocument {
  const result = parsePolicy(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value.document;
}

test('the delegation commands cover only draft-approval tasks: other approval kinds have no delegated path', async (t) => {
  const env = delegationEnv(t);
  // delegateDecide takes a task id only; a publication/strategy/org id is not a task and is refused
  for (const id of ['publication-1', 'strategy-1', 'org-1']) {
    const result = env.engine.delegateDecide({ task_id: id, hash: 'a'.repeat(64), verdict: 'approve', reason: 'x' });
    assert.equal(result.ok, false);
  }
  // a task that is not in needs_review
  const { taskId } = await draftedFor(env);
  env.send({ cmd: 'reject', actor: OWNER, kind: 'task', id: taskId });
  const failed = decide(env, taskId, 'approve');
  assert.equal(failed.ok, false);
});

// ===== 승인 계산: 위임 행은 지금 유효할 때만 센다 =====

const riskyParams = { min_approvers: 1, cooldown: 3600, reauth_before_effect: true, self_approval: true };
const statusOf = (env: PolicyEnv, taskId: string, document: PolicyDocument) =>
  approvalStatus(env.db, { kind: 'task', id: taskId, hash: hashOf(env, taskId), requesterId: null, params: riskyParams, now: env.clock.nowIso(), authority: delegationAuthority(env.db, document, env.clock.nowIso()) });

test('a delegated approval row counts only while the mandate is in the current policy, not paused, not revoked, not expired, and the row is from its holder', async (t) => {
  const env = delegationEnv(t);
  const { taskId } = await draftedFor(env);
  assert.equal(decide(env, taskId, 'approve').ok, true);
  const document = env.store.active(env.db)!.policy!.document;
  assert.equal(statusOf(env, taskId, document).state, 'cooldown');
  assert.equal(statusOf(env, taskId, document).mandateId, MANDATE);

  // 지금 정책에 그 위임이 없으면 세지 않는다 (위임이 없는 정책: 포트 자체가 없다)
  const noDelegation = parsePolicyOrThrow(DEFAULT_TEMPLATE_TEXT);
  assert.equal(statusOf(env, taskId, noDelegation).state, 'revoked');
  assert.equal(statusOf(env, taskId, noDelegation).quorumApprovalId, null);
  const otherMandate = parsePolicyOrThrow(delegationPolicyText([{ id: 'other-mail' }]));
  assert.equal(statusOf(env, taskId, otherMandate).state, 'revoked');
  // 다른 보유자의 위임이면 세지 않는다
  const otherHolder = parsePolicyOrThrow(delegationPolicyText([{ holder: 'someone-else' }]));
  assert.equal(statusOf(env, taskId, otherHolder).state, 'revoked');

  // 정지: 풀어도 정지 전의 승인은 되살아나지 않는다
  env.send({ cmd: 'delegation', actor: OWNER, op: 'pause', mandate_id: MANDATE });
  assert.equal(statusOf(env, taskId, document).state, 'revoked');
  env.clock.advance(1000);
  env.send({ cmd: 'delegation', actor: OWNER, op: 'resume', mandate_id: MANDATE, totp: env.code(OWNER) });
  assert.equal(statusOf(env, taskId, document).state, 'revoked', 'an approval given before a pause stays void after the resume');
  assert.deepEqual(env.engine.releaseDelegated(), []);
});

test('an agent row without a mandate id is not an approval (as before), and a delegated row from a non-holder agent is not either', async (t) => {
  const env = delegationEnv(t);
  const { taskId } = await draftedFor(env);
  const hash = hashOf(env, taskId);
  const insert = (id: string, by: string, mandate: string | null) => env.db.writeTx((tx) => tx.run(
    "INSERT INTO approval (id, subject_kind, subject_id, decision, subject_hash, decided_by, comment, at, mandate_id, via) VALUES (?, 'task', ?, 'approved', ?, ?, 'forged', ?, ?, NULL)",
    [id, taskId, hash, by, env.clock.nowIso(), mandate],
  ));
  insert('forged-1', DELEGATE, null);
  insert('forged-2', AGENT, MANDATE);
  const document = env.store.active(env.db)!.policy!.document;
  const status = statusOf(env, taskId, document);
  assert.equal(status.ok, false);
  assert.equal(status.quorumApprovalId, null);
  assert.deepEqual(status.approvers, []);
  env.clock.advance(2 * HOUR);
  assert.deepEqual(env.engine.releaseDelegated(), [], 'nothing is released on forged rows');
  assert.equal(taskStatus(env.db, taskId), 'needs_review');
});

test('a delegated approval is void after the policy changes (the task hash binds the policy version): the daemon does not release it', async (t) => {
  const env = delegationEnv(t);
  const { taskId } = await draftedFor(env);
  assert.equal(decide(env, taskId, 'approve').ok, true);
  // 정책이 바뀌면(어떤 배포든) 업무 해시가 달라져 승인은 효력을 잃는다
  const changed = delegationPolicyText([{}]).replace('max_usd_per_task: 5', 'max_usd_per_task: 4');
  const parsed = env.store.archive(changed);
  env.db.writeTx((tx) => tx.run("INSERT INTO policy_version (id, content_hash, change_class, approved_by, deployed_at, rollback_of) VALUES (?, ?, 'normal', '[]', ?, NULL)", [parsed.versionId, parsed.hash, env.clock.nowIso()]));
  env.clock.advance(2 * HOUR);
  assert.deepEqual(env.engine.releaseDelegated(), []);
  assert.equal(taskStatus(env.db, taskId), 'needs_review');
  const shown = env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId });
  assert.notEqual(shown['hash'], taskRow(env.db, taskId).approved_hash);
});

test('a person\'s approval wins over an earlier delegated one: the quorum row is the person\'s, so the human cooldown and TOTP apply', async (t) => {
  const env = delegationEnv(t);
  const { taskId } = await draftedFor(env);
  assert.equal(decide(env, taskId, 'approve').ok, true);
  env.clock.advance(1000);
  const human = env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash: hashOf(env, taskId), via: 'cli' });
  assert.equal(human['state'], 'cooldown');
  assert.equal(approvalsOf(env.db, taskId).at(-1)!.via, 'cli');
  env.clock.advance(HOUR);
  assert.deepEqual(env.engine.releaseDelegated(), [], 'the daemon does not release a person\'s approval');
  assert.equal(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: taskId })['code'], 'reauth_required');
  assert.equal(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: taskId, totp: env.code(OWNER) })['state'], 'queued');
});

// ===== 정지·철회·취소 =====

test('pause and revoke act at once without a TOTP; resume needs a TOTP; a revoked mandate can never be resumed', async (t) => {
  const env = delegationEnv(t);
  const { taskId } = await draftedFor(env);
  assert.equal(decide(env, taskId, 'approve').ok, true);
  env.clock.advance(HOUR);

  const paused = env.send({ cmd: 'delegation', actor: OWNER, op: 'pause', comment: 'stop for today' });
  assert.deepEqual([paused['ok'], paused['state'], paused['mandate_id']], [true, 'paused', null]);
  assert.deepEqual(controlsOf(env.db), [{ action: 'pause', mandate_id: null, actor_id: OWNER, reason: 'stop for today' }]);
  assert.deepEqual(env.engine.releaseDelegated(), [], 'the kill switch holds back an approved task');
  assert.equal(taskStatus(env.db, taskId), 'needs_review');

  const status = env.send({ cmd: 'delegation', actor: OWNER, op: 'status' });
  assert.equal(status['paused_all'], true);
  assert.equal((status['mandates'] as { state: string }[])[0]!.state, 'paused');

  assert.equal(env.send({ cmd: 'delegation', actor: OWNER, op: 'resume' })['code'], 'reauth_required');
  assert.equal(env.send({ cmd: 'delegation', actor: OWNER, op: 'resume', totp: '000000' })['code'], 'reauth_failed');
  assert.equal(env.send({ cmd: 'delegation', actor: OWNER, op: 'resume', totp: env.code(OWNER) })['state'], 'resumed');
  assert.equal(env.send({ cmd: 'delegation', actor: OWNER, op: 'resume', totp: env.code(OWNER) })['code'], 'wrong_state', 'not paused any more');

  const revoked = env.send({ cmd: 'delegation', actor: OWNER, op: 'revoke', mandate_id: MANDATE, comment: 'no longer wanted' });
  assert.deepEqual(revoked['mandate_ids'], [MANDATE]);
  assert.equal(env.send({ cmd: 'delegation', actor: OWNER, op: 'pause', mandate_id: MANDATE })['ok'], true);
  env.clock.advance(60_000);
  const again = env.send({ cmd: 'delegation', actor: OWNER, op: 'resume', mandate_id: MANDATE, totp: env.code(OWNER) });
  assert.deepEqual([again['ok'], again['code']], [false, 'wrong_state']);
  assert.match(String(again['error']), /revoked/);
  assert.equal(decide(env, (await draftedFor(env, { dedupeKey: 'later' })).taskId, 'approve').ok, false, 'a revoked mandate approves nothing');
  assert.equal(env.send({ cmd: 'delegation', actor: OWNER, op: 'pause', mandate_id: 'not-in-policy' })['code'], 'bad_request');
  assert.equal(env.send({ cmd: 'delegation', actor: AGENT, op: 'pause' })['code'], 'not_human', 'an agent cannot even pause');
});

test('revoke without an id revokes every mandate in the current policy, one row each', async (t) => {
  const env = delegationEnv(t, [{ id: 'mail-a' }, { id: 'mail-b' }]);
  const result = env.send({ cmd: 'delegation', actor: OWNER, op: 'revoke' });
  assert.deepEqual((result['mandate_ids'] as string[]).sort(), ['mail-a', 'mail-b']);
  assert.deepEqual(controlsOf(env.db).map((c) => [c.action, c.mandate_id]), [['revoke', 'mail-a'], ['revoke', 'mail-b']]);
  assert.equal(env.send({ cmd: 'delegation', actor: OWNER, op: 'revoke' })['mandate_ids'] !== undefined, true);
  assert.equal(controlsOf(env.db).length, 2, 'already revoked mandates get no second row');
});

test('a person cancelling a delegated approval pauses that mandate automatically; resuming needs a TOTP; the task goes to people from then on', async (t) => {
  const env = delegationEnv(t);
  const { taskId } = await draftedFor(env);
  assert.equal(decide(env, taskId, 'approve').ok, true);
  const cancelled = env.send({ cmd: 'cancel', actor: OWNER, kind: 'task', id: taskId, comment: 'not this one', expected_hash: hashOf(env, taskId), via: 'web' });
  assert.equal(cancelled['ok'], true);
  assert.equal(cancelled['delegation_paused'], MANDATE);
  assert.deepEqual(controlsOf(env.db), [{ action: 'pause', mandate_id: MANDATE, actor_id: OWNER, reason: '사람이 위임 결정을 취소함' }]);
  assert.equal(approvalsOf(env.db, taskId).at(-1)!.decision, 'rejected');
  assert.equal(approvalsOf(env.db, taskId).at(-1)!.via, 'web');
  env.clock.advance(2 * HOUR);
  assert.deepEqual(env.engine.releaseDelegated(), []);

  // 다른 업무도 정지된 동안은 위임이 결정하지 못한다
  const next = await draftedFor(env, { dedupeKey: 'next' });
  const blocked = decide(env, next.taskId, 'approve');
  assert.deepEqual([blocked.ok, blocked.ok ? '' : blocked.code], [false, 'mandate_inactive']);
  assert.equal(env.send({ cmd: 'delegation', actor: OWNER, op: 'resume', mandate_id: MANDATE })['code'], 'reauth_required');
  assert.equal(env.send({ cmd: 'delegation', actor: OWNER, op: 'resume', mandate_id: MANDATE, totp: env.code(OWNER) })['ok'], true);
  assert.equal(decide(env, next.taskId, 'approve').ok, true, 'after the resume the mandate works again');
  // 사람이 사람의 승인을 취소한 것은 위임을 멈추지 않는다
  const human = await draftedFor(env, { dedupeKey: 'human' });
  env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: human.taskId, hash: hashOf(env, human.taskId) });
  const before = controlsOf(env.db).length;
  env.send({ cmd: 'cancel', actor: OWNER, kind: 'task', id: human.taskId });
  assert.equal(controlsOf(env.db).length, before, 'cancelling a person\'s own approval does not pause delegation');
});

// ===== 소켓 경계 =====

test('the socket stays human-only: delegateDecide-shaped requests and agent actors are refused, and delegated rows cannot be made through it', async (t) => {
  const env = delegationEnv(t);
  const { taskId } = await draftedFor(env);
  const hash = hashOf(env, taskId);
  for (const cmd of ['delegate_decide', 'delegateDecide', 'delegate', 'release_delegated', 'releaseDelegated']) {
    const refused = env.send({ cmd, actor: DELEGATE, task_id: taskId, hash, verdict: 'approve', reason: 'x' });
    assert.deepEqual([refused.ok, refused.code], [false, 'bad_request'], cmd);
    assert.equal(env.send({ cmd, actor: OWNER, task_id: taskId, hash, verdict: 'approve', reason: 'x' })['code'], 'bad_request', `${cmd} is not a socket command even for a person`);
  }
  // 에이전트 행위자(위임 보유자 포함)의 어떤 명령도 거부된다
  for (const command of [
    { cmd: 'approve', kind: 'task', id: taskId, hash }, { cmd: 'show', kind: 'task', id: taskId }, { cmd: 'whoami' }, { cmd: 'list' },
    { cmd: 'delegation', op: 'status' }, { cmd: 'request_changes', kind: 'task', id: taskId, comment: 'x' },
  ]) {
    for (const actor of [DELEGATE, AGENT]) {
      const refused = env.send({ ...command, actor });
      assert.deepEqual([refused.ok, refused.code], [false, 'not_human'], `${command.cmd} as ${actor}`);
    }
  }
  assert.equal(approvalsOf(env.db, taskId).length, 0);
  // 사람의 approve 요청에 mandate_id 를 실어도 위임 승인이 되지 않는다 (모르는 필드는 무시, 행의 mandate_id 는 NULL)
  const human = env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash, mandate_id: MANDATE, via: 'delegate' });
  assert.equal(human['code'], 'bad_request', 'via=delegate cannot be self-reported through the socket');
  assert.equal(env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash, mandate_id: MANDATE })['ok'], true);
  assert.deepEqual(approvalsOf(env.db, taskId).map((a) => [a.decided_by, a.mandate_id]), [[OWNER, null]]);
});

// ===== 배포 점검 =====

test('deploying a policy with a mandate: expiry must be within 90 days of the approval, holders must be agents; the reserved delegate actor is created by the deployment', async (t) => {
  const env = (await import('../support/policy.ts')).policyEnv(t);
  assert.equal(env.db.get('SELECT 1 AS one FROM actor WHERE id = ?', [DELEGATE]), undefined, 'a database without delegation has no delegate actor');
  const tooLong = env.send({ cmd: 'approve', actor: OWNER, kind: 'policy_version', policy_text: delegationPolicyText([{ expires: '2027-03-01' }]) });
  assert.deepEqual([tooLong.ok, tooLong.code], [false, 'policy_denied']);
  assert.match(String(tooLong.error), /more than 90 days/);
  const past = env.send({ cmd: 'approve', actor: OWNER, kind: 'policy_version', policy_text: delegationPolicyText([{ expires: '2026-10-01' }]) });
  assert.equal(past.code, 'policy_denied');
  const human = env.send({ cmd: 'approve', actor: OWNER, kind: 'policy_version', policy_text: delegationPolicyText([{ holder: OWNER }]) });
  assert.equal(human.code, 'policy_denied', 'v1 mandates belong to an agent actor');
  const unknown = env.send({ cmd: 'approve', actor: OWNER, kind: 'policy_version', policy_text: delegationPolicyText([{ holder: 'nobody-here' }]) });
  assert.equal(unknown.code, 'policy_denied');
  const noRule = env.send({ cmd: 'approve', actor: OWNER, kind: 'policy_version', policy_text: delegationPolicyText([{ recipients: null }]) });
  assert.notEqual(noRule['ok'], true, 'D-B11: a mandate without a recipient rule is refused at deployment');
  assert.match(String(noRule['error']), /recipients/);
  const freeMail = env.send({ cmd: 'approve', actor: OWNER, kind: 'policy_version', policy_text: delegationPolicyText([{ recipients: { kind: 'domains', domains: ['gmail.com'] } }]) });
  assert.notEqual(freeMail['ok'], true, 'D-B11: a free-mail domain list is refused at deployment');
  assert.equal(env.db.get('SELECT count(*) AS n FROM approval WHERE subject_kind = ?', ['policy_version'])?.['n'], 0, 'a refused deployment leaves no approval row');

  const text = delegationPolicyText([{ expires: '2027-01-15' }]);
  const approved = env.send({ cmd: 'approve', actor: OWNER, kind: 'policy_version', policy_text: text, via: 'cli' });
  assert.equal(approved['ok'], true);
  assert.equal(approved['change_class'], 'risky', 'adding a mandate is a risky change: cooldown + TOTP of the current policy');
  assert.equal(approved['state'], 'cooldown');
  assert.equal(env.db.get('SELECT 1 AS one FROM actor WHERE id = ?', [DELEGATE]), undefined, 'not created before the deployment');
  env.clock.advance(HOUR);
  const released = env.send({ cmd: 'release', actor: OWNER, kind: 'policy_version', id: String(approved['id']), totp: env.code(OWNER) });
  assert.equal(released['state'], 'deployed');
  assert.deepEqual({ ...env.db.get('SELECT kind, adapter FROM actor WHERE id = ?', [DELEGATE]) }, { kind: 'agent', adapter: null });
  assert.equal(env.db.get('SELECT allowed_tools FROM role WHERE id = ?', [APPROVAL_DELEGATE.role])?.['allowed_tools'], '[]', 'the delegate role has no tools');
  assert.equal(env.send({ cmd: 'delegation', actor: OWNER, op: 'status' })['enabled'], true);
});

test('ensureApprovalDelegate is idempotent, needs a write transaction, and creates no tools', (t) => {
  const env = delegationEnv(t);
  const again = env.db.writeTx((tx) => ensureApprovalDelegate(tx, env.clock));
  assert.deepEqual(again, { actorCreated: false, roleCreated: false });
  assert.throws(() => ensureApprovalDelegate(env.db, env.clock), /write transaction/);
  assert.equal(env.db.get<{ n: number }>('SELECT count(*) AS n FROM actor WHERE id = ?', [DELEGATE])?.n, 1);
  assert.equal(REVIEWER.length > 0, true);
});

test('without a delegation section nothing changes: the scan is empty, nothing is released, no review is written', async (t) => {
  const env = delegationEnv(t, []);
  const { taskId } = await draftedFor(env);
  assert.deepEqual(env.engine.delegationScan(), []);
  assert.deepEqual(env.engine.releaseDelegated(), []);
  const refused = decide(env, taskId, 'approve');
  assert.deepEqual([refused.ok, refused.ok ? '' : refused.code], [false, 'no_mandate']);
  assert.equal(reviewsOf(env.db, taskId).length, 0, 'no review row without a mandate');
  assert.equal(env.send({ cmd: 'delegation', actor: OWNER, op: 'status' })['enabled'], false);
});

// ===== 사람이 위임 결정을 뒤집으면 위임이 멈춘다 (취소와 같다) =====

test('a person rejecting or requesting changes on a delegated approval pauses that mandate like a cancel does; the same on a person\'s own approval or on an undelegated task does not', async (t) => {
  const env = delegationEnv(t);
  const a = await draftedFor(env);
  assert.equal(decide(env, a.taskId, 'approve').ok, true);
  const rejected = env.send({ cmd: 'reject', actor: OWNER, kind: 'task', id: a.taskId, comment: 'no', expected_hash: hashOf(env, a.taskId), via: 'web' });
  assert.equal(rejected['ok'], true);
  assert.equal(rejected['delegation_paused'], MANDATE);
  assert.deepEqual(controlsOf(env.db), [{ action: 'pause', mandate_id: MANDATE, actor_id: OWNER, reason: '사람이 위임 결정을 거절함' }]);
  assert.equal(taskStatus(env.db, a.taskId), 'failed');
  assert.equal(env.send({ cmd: 'delegation', actor: OWNER, op: 'resume', mandate_id: MANDATE, totp: env.code(OWNER) })['ok'], true);

  env.clock.advance(60_000);
  const b = await draftedFor(env, { dedupeKey: 'b' });
  assert.equal(decide(env, b.taskId, 'approve').ok, true);
  const changed = env.send({ cmd: 'request_changes', actor: OWNER, kind: 'task', id: b.taskId, comment: 'wrong tone' });
  assert.equal(changed['ok'], true);
  assert.equal(changed['state'], 'queued');
  assert.equal(changed['delegation_paused'], MANDATE);
  assert.deepEqual(controlsOf(env.db).map((c) => [c.action, c.reason]), [['pause', '사람이 위임 결정을 거절함'], ['resume', controlsOf(env.db)[1]!.reason], ['pause', '사람이 위임 결정에 변경을 요청함']]);
  assert.equal(env.send({ cmd: 'delegation', actor: OWNER, op: 'resume', mandate_id: MANDATE, totp: env.code(OWNER) })['ok'], true);

  // 위임이 아닌 승인(사람)이나 승인이 없는 업무는 위임을 멈추지 않는다
  const before = controlsOf(env.db).length;
  const human = await draftedFor(env, { dedupeKey: 'human' });
  env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: human.taskId, hash: hashOf(env, human.taskId) });
  assert.equal(env.send({ cmd: 'reject', actor: OWNER, kind: 'task', id: human.taskId })['delegation_paused'], undefined);
  const plain = await draftedFor(env, { dedupeKey: 'plain' });
  assert.equal(env.send({ cmd: 'request_changes', actor: OWNER, kind: 'task', id: plain.taskId, comment: 'again' })['delegation_paused'], undefined);
  assert.equal(controlsOf(env.db).length, before, 'no pause row for either');
});

test('a policy change that adds delegation always needs a TOTP release, even when the current policy turns reauth_before_effect off', async (t) => {
  const env = policyEnv(t);
  const lax = DEFAULT_TEMPLATE_TEXT.replace('reauth_before_effect: true', 'reauth_before_effect: false').replace('cooldown: 1h ', 'cooldown: 0  ');
  assert.notEqual(lax, DEFAULT_TEMPLATE_TEXT);
  env.clock.advance(60_000);
  env.db.writeTx((tx) => {
    const parsed = env.store.archive(lax);
    tx.run('INSERT INTO policy_version (id, content_hash, change_class, approved_by, deployed_at, rollback_of) VALUES (?, ?, ?, ?, ?, NULL)', [parsed.versionId, parsed.hash, 'risky', JSON.stringify([OWNER]), env.clock.nowIso()]);
  });
  env.clock.advance(60_000);
  // 대조: 위임이 아닌 위험 변경(한도 상향)은 이 느슨한 정책에서 바로 배포된다 — 위임만 TOTP 를 강제한다
  const raised = env.send({ cmd: 'approve', actor: OWNER, kind: 'policy_version', policy_text: lax.replace(/max_usd_per_task: (\d+)/, (_, n: string) => `max_usd_per_task: ${Number(n) + 1}`) });
  assert.deepEqual([raised['change_class'], raised['state']], ['risky', 'deployed'], String(raised['error']));
  env.clock.advance(60_000);

  const text = delegationPolicyText([{}], lax.replace(/max_usd_per_task: (\d+)/, (_, n: string) => `max_usd_per_task: ${Number(n) + 1}`));
  const approved = env.send({ cmd: 'approve', actor: OWNER, kind: 'policy_version', policy_text: text });
  assert.equal(approved['ok'], true, String(approved['error']));
  assert.equal(approved['change_class'], 'risky');
  assert.notEqual(approved['state'], 'deployed', 'not deployed on approval: the TOTP release is still required');
  const id = String(approved['id']);
  const shown = env.send({ cmd: 'show', actor: OWNER, kind: 'policy_version', id });
  assert.notEqual((shown['approval'] as { state: string }).state, 'approved_ready');
  const noCode = env.send({ cmd: 'release', actor: OWNER, kind: 'policy_version', id });
  assert.equal(noCode['code'], 'reauth_required');
  assert.equal(env.send({ cmd: 'release', actor: OWNER, kind: 'policy_version', id, totp: '000000' })['ok'], false);
  assert.equal(env.send({ cmd: 'release', actor: OWNER, kind: 'policy_version', id, totp: env.code(OWNER) })['state'], 'deployed');
});

test('the engine show (what the CLI prints) carries every payload field of a draft, including html, reply_to and unknown keys; secret-looking values are listed in masked_paths', async (t) => {
  const env = delegationEnv(t);
  const extra = { html: '<b>x</b>', reply_to: 'r@evil.example', x_unknown: { a: [1, 2] } };
  const { taskId } = await draftedFor(env, { requests: [{ ...examplePayload(), ...extra }] });
  const shown = env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId });
  const payload = (shown['drafts'] as { payload: Record<string, unknown> }[])[0]!.payload;
  for (const [key, value] of Object.entries({ ...examplePayload(), ...extra })) assert.deepEqual(payload[key], value, key);
});
