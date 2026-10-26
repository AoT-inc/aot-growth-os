// 전화 정책 (ADR-0014 §8): `phone:` 섹션 형식, 변경 등급, PhoneCallPolicy 판정과 policy_decision 기록.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyPhoneEvent, createOutboundCall, type PhoneCallPolicyRequest } from '@aot/domain';
import { classifyChange, createPhoneCallPolicy, parsePolicy } from '@aot/policy';

import { ev, FROM, PROVIDER, TO } from '../support/phone.ts';
import { deployDirect, policyEnv, policyText, DEFAULT_TEMPLATE_TEXT } from '../support/policy.ts';
import { queuedTask } from '../support/engine.ts';

const PHONE_SECTION = `
phone:
  allowed_regions: ["+82"]
  denied_numbers: ["+821000000099"]
  caller_ids: ["${FROM}"]
  max_duration_seconds: 600
  max_calls_per_day: 2
  recording: allowed
  transfer_targets: ["+82200000009"]
  business_hours:
    tz: Asia/Seoul
    days: [1, 2, 3, 4, 5]
    start: "09:00"
    end: "18:00"
`;
const withPhone = (section = PHONE_SECTION): string => policyText((yaml) => `${yaml}${section}`);
const parse = (text: string) => {
  const parsed = parsePolicy(text);
  assert.ok(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed.errors));
  return parsed.value;
};

const WEEKDAY_NOON = '2026-10-26T03:00:00.000Z'; // 월 12:00 KST
const SUNDAY = '2026-10-25T03:00:00.000Z';

function request(now: string, over: Partial<PhoneCallPolicyRequest> = {}, call: Partial<NonNullable<PhoneCallPolicyRequest['call']>> = {}): PhoneCallPolicyRequest {
  return { kind: 'call', runId: null, taskId: null, subject: 'generalist@v1', to: TO, call: { objective: 'qualify_lead', ...call }, now, ...over };
}

test('the phone section is optional: documents without it keep their policy version (content hash)', () => {
  const before = parse(DEFAULT_TEMPLATE_TEXT);
  assert.equal(before.document.phone, undefined);
  assert.ok(!JSON.stringify(before.document).includes('phone'));
  const withSection = parse(withPhone());
  assert.notEqual(withSection.hash, before.hash);
  assert.deepEqual(withSection.document.phone?.allowed_regions, ['+82']);
  assert.equal(withSection.document.phone?.business_hours?.tz, 'Asia/Seoul');
});

test('the phone section is validated: unknown keys, missing limits and bad numbers are refused', () => {
  for (const [section, path] of [
    ['phone:\n  allowed_regions: ["+82"]\n  caller_ids: ["+82200000000"]\n  max_duration_seconds: 600\n', 'phone.max_calls_per_day'],
    ['phone:\n  allowed_regions: ["82"]\n  caller_ids: ["+82200000000"]\n  max_duration_seconds: 600\n  max_calls_per_day: 1\n', 'phone.allowed_regions'],
    ['phone:\n  allowed_regions: ["+82"]\n  caller_ids: ["02-1234"]\n  max_duration_seconds: 600\n  max_calls_per_day: 1\n', 'phone.caller_ids'],
    ['phone:\n  allowed_regions: ["+82"]\n  caller_ids: ["+82200000000"]\n  max_duration_seconds: 5\n  max_calls_per_day: 1\n', 'phone.max_duration_seconds'],
    ['phone:\n  allowed_regions: ["+82"]\n  caller_ids: ["+82200000000"]\n  max_duration_seconds: 600\n  max_calls_per_day: 1\n  recording: sometimes\n', 'phone.recording'],
    ['phone:\n  allowed_regions: ["+82"]\n  caller_ids: ["+82200000000"]\n  max_duration_seconds: 600\n  max_calls_per_day: 1\n  record_everything: true\n', 'phone.record_everything'],
    ['phone:\n  allowed_regions: ["+82"]\n  caller_ids: ["+82200000000"]\n  max_duration_seconds: 600\n  max_calls_per_day: 1\n  business_hours:\n    days: [1]\n    start: "09:00"\n    end: "18:00"\n', 'phone.business_hours.tz'],
  ] as const) {
    const parsed = parsePolicy(withPhone(section));
    assert.ok(!parsed.ok, section);
    assert.ok(!parsed.ok && parsed.errors.some((e) => e.path === path), `${path}: ${JSON.stringify(!parsed.ok && parsed.errors)}`);
  }
});

test('policy changes: anything that allows more calls is risky, tightening and removal are normal', () => {
  const base = parse(withPhone()).document;
  const change = (edit: (section: string) => string) => classifyChange(base, parse(withPhone(edit(PHONE_SECTION))).document);
  assert.equal(classifyChange(parse(DEFAULT_TEMPLATE_TEXT).document, base).changeClass, 'risky', 'adding the section enables phone calls');
  assert.equal(classifyChange(base, parse(DEFAULT_TEMPLATE_TEXT).document).changeClass, 'normal', 'removing the section denies every call');
  assert.equal(change((s) => s).changeClass, 'normal');
  for (const [name, edit] of [
    ['a region is added', (s: string) => s.replace('["+82"]', '["+82", "+1"]')],
    ['a denied number is removed', (s: string) => s.replace('denied_numbers: ["+821000000099"]', 'denied_numbers: []')],
    ['a caller id is added', (s: string) => s.replace(`caller_ids: ["${FROM}"]`, `caller_ids: ["${FROM}", "+82200000002"]`)],
    ['the daily limit rises', (s: string) => s.replace('max_calls_per_day: 2', 'max_calls_per_day: 3')],
    ['the duration limit rises', (s: string) => s.replace('max_duration_seconds: 600', 'max_duration_seconds: 900')],
    ['a transfer target is added', (s: string) => s.replace('transfer_targets: ["+82200000009"]', 'transfer_targets: ["+82200000009", "+82200000008"]')],
    ['recording becomes required', (s: string) => s.replace('recording: allowed', 'recording: required')],
    ['the calling hours widen', (s: string) => s.replace('end: "18:00"', 'end: "21:00"')],
  ] as const) assert.equal(change(edit).changeClass, 'risky', name);
  for (const [name, edit] of [
    ['the region list narrows', (s: string) => s.replace('allowed_regions: ["+82"]', 'allowed_regions: ["+8210"]')],
    ['a denied number is added', (s: string) => s.replace('denied_numbers: ["+821000000099"]', 'denied_numbers: ["+821000000099", "+821000000098"]')],
    ['the daily limit falls', (s: string) => s.replace('max_calls_per_day: 2', 'max_calls_per_day: 1')],
    ['recording becomes forbidden', (s: string) => s.replace('recording: allowed', 'recording: forbidden')],
    ['the calling hours narrow', (s: string) => s.replace('start: "09:00"', 'start: "10:00"')],
  ] as const) assert.equal(change(edit).changeClass, 'normal', name);
});

test('without a phone section every call is denied, and the decision is recorded without the number', (t) => {
  const env = policyEnv(t);
  deployDirect(env, DEFAULT_TEMPLATE_TEXT);
  const policy = createPhoneCallPolicy({ db: env.db, store: env.store });
  const verdict = policy.judge(request(WEEKDAY_NOON));
  assert.equal(verdict.decision, 'deny');
  const rows = env.db.all<{ action: string; decision: string; resource: string; scope: string; impact: string }>('SELECT action, decision, resource, scope, impact FROM policy_decision');
  assert.deepEqual(rows.map((r) => [r.action, r.decision, r.scope, r.impact]), [['phone_call.call', 'deny', 'customer', 'external_effect']]);
  assert.ok(!rows[0]!.resource.includes('0000000'), 'the number is masked in the decision record');
});

test('with no deployed policy at all, calls are denied', (t) => {
  const env = policyEnv(t);
  env.db.writeTx((tx) => tx.run('DELETE FROM policy_version'));
  assert.equal(createPhoneCallPolicy({ db: env.db, store: env.store }).judge(request(WEEKDAY_NOON)).decision, 'deny');
});

test('call limits: denied numbers, regions, hours, caller id, recording, duration clamp and the daily count', (t) => {
  const env = policyEnv(t);
  deployDirect(env, withPhone());
  const policy = createPhoneCallPolicy({ db: env.db, store: env.store });
  const reason = (verdict: ReturnType<typeof policy.judge>) => ('reason' in (verdict as object) ? (verdict as { reason: string }).reason : '');

  const ok = policy.judge(request(WEEKDAY_NOON, {}, { constraints: { maxDurationSeconds: 3000, allowTransfer: true } }));
  assert.deepEqual(ok, { decision: 'allow', grant: { from: FROM, maxDurationSeconds: 600, recording: false, allowTransfer: true } }, 'duration is clamped to the policy maximum');

  assert.match(reason(policy.judge(request(WEEKDAY_NOON, { to: '+821000000099' }))), /denied list/);
  assert.match(reason(policy.judge(request(WEEKDAY_NOON, { to: '+15550100123' }))), /outside the allowed regions/);
  assert.match(reason(policy.judge(request(SUNDAY))), /calling hours/);
  assert.match(reason(policy.judge(request(WEEKDAY_NOON, {}, { from: '+82299999999' }))), /caller id/);
  const recorded = policy.judge(request(WEEKDAY_NOON, {}, { constraints: { recording: true } }));
  assert.equal(recorded.decision === 'allow' && recorded.grant.recording, true);

  // 일일 통화량: 최근 24시간 발신 통화 2건이면 세 번째는 거부
  const taskA = queuedTask(env.db, env.clock);
  const taskB = queuedTask(env.db, env.clock, { trigger: { kind: 'manual', ref: 'actor:other' } });
  for (const [index, taskId] of [taskA, taskB].entries()) {
    const { call } = createOutboundCall(env.db, env.clock, {
      provider: PROVIDER, to: TO, from: FROM, taskId, taskRunId: null, actorId: null, orgUnitId: null, objective: 'qualify_lead',
      effectKey: `k${index}`.padEnd(40, '0'), maxDurationSeconds: 60, allowTransfer: false, recording: false,
    });
    applyPhoneEvent(env.db, env.clock, ev('phone.call.initiated', `p${index}`, env.clock.nowIso(), { callId: call.id }));
  }
  const later = new Date(Date.parse(env.clock.nowIso()) + 3600_000).toISOString(); // 월 10:00 KST: 영업시간 안
  const atLimit = policy.judge(request(later));
  assert.equal(atLimit.decision, 'deny');
  assert.match(reason(atLimit), /daily call limit/);
});

test('recording rules: forbidden refuses a recording request, required forces it', (t) => {
  const env = policyEnv(t);
  deployDirect(env, withPhone(PHONE_SECTION.replace('recording: allowed', 'recording: forbidden')));
  const forbidden = createPhoneCallPolicy({ db: env.db, store: env.store }).judge(request(WEEKDAY_NOON, {}, { constraints: { recording: true } }));
  assert.equal(forbidden.decision, 'deny');
  const env2 = policyEnv(t);
  deployDirect(env2, withPhone(PHONE_SECTION.replace('recording: allowed', 'recording: required')));
  const required = createPhoneCallPolicy({ db: env2.db, store: env2.store }).judge(request(WEEKDAY_NOON));
  assert.equal(required.decision === 'allow' && required.grant.recording, true);
});

test('transfer: only to listed targets and only for calls created with transfer allowed', (t) => {
  const env = policyEnv(t);
  deployDirect(env, withPhone());
  const policy = createPhoneCallPolicy({ db: env.db, store: env.store });
  const transfer = (to: string, allows: boolean) => policy.judge({ kind: 'transfer', runId: null, taskId: null, subject: 'generalist@v1', to, call: null, callAllowsTransfer: allows, now: SUNDAY });
  assert.equal(transfer('+82200000009', true).decision, 'allow', 'human escalation is not limited by calling hours');
  assert.equal(transfer('+82200000009', false).decision, 'deny');
  assert.equal(transfer('+82200000001', true).decision, 'deny');
});

test('daily limits: max_calls_per_day is an instance-wide ceiling, max_calls_per_day_per_org_unit counts each organization unit separately', (t) => {
  const env = policyEnv(t);
  deployDirect(env, withPhone(PHONE_SECTION.replace('max_calls_per_day: 2', 'max_calls_per_day: 3\n  max_calls_per_day_per_org_unit: 1')));
  const policy = createPhoneCallPolicy({ db: env.db, store: env.store });
  env.db.writeTx((tx) => tx.run("INSERT INTO org_unit (id, parent_id, slug, lifecycle, name, responsibility, created_at) VALUES ('unit-b', NULL, 'unit-b', 'active', 'B', 'second unit', ?)", [env.clock.nowIso()]));
  const taskA = queuedTask(env.db, env.clock);
  const taskB = queuedTask(env.db, env.clock, { trigger: { kind: 'manual', ref: 'actor:other' } });
  env.db.writeTx((tx) => { tx.run("UPDATE task SET org_unit_id = 'unit-b' WHERE id = ?", [taskB]); });
  const unitA = env.db.get<{ org_unit_id: string }>('SELECT org_unit_id FROM task WHERE id = ?', [taskA])!.org_unit_id;
  assert.notEqual(unitA, 'unit-b');
  const later = new Date(Date.parse(env.clock.nowIso()) + 3600_000).toISOString(); // 월 10:00 KST
  const ask = (taskId: string) => policy.judge(request(later, { taskId }));
  assert.equal(ask(taskA).decision, 'allow');
  // 조직 A 가 하루 한 통을 쓰면 A 의 다음 요청은 거부되지만 B 는 아직 쓸 수 있다
  const { call } = createOutboundCall(env.db, env.clock, {
    provider: PROVIDER, to: TO, from: FROM, taskId: taskA, taskRunId: null, actorId: null, orgUnitId: unitA, objective: 'qualify_lead',
    effectKey: 'a'.repeat(40), maxDurationSeconds: 60, allowTransfer: false, recording: false,
  });
  applyPhoneEvent(env.db, env.clock, ev('phone.call.initiated', 'pa', env.clock.nowIso(), { callId: call.id }));
  const denied = ask(taskA);
  assert.equal(denied.decision, 'deny');
  assert.match(denied.decision === 'deny' ? denied.reason : '', /organization unit/);
  assert.equal(ask(taskB).decision, 'allow', 'one organization unit cannot exhaust another one\'s quota');
  // 총 상한은 모두를 합쳐 센다
  for (const [index, [taskId, unit]] of ([[taskB, 'unit-b'], [taskB, 'unit-b']] as const).entries()) {
    const created = createOutboundCall(env.db, env.clock, {
      provider: PROVIDER, to: TO, from: FROM, taskId, taskRunId: null, actorId: null, orgUnitId: unit, objective: `qualify_${index}`,
      effectKey: `b${index}`.padEnd(40, '0'), maxDurationSeconds: 60, allowTransfer: false, recording: false,
    }).call;
    applyPhoneEvent(env.db, env.clock, ev('phone.call.initiated', `pb${index}`, env.clock.nowIso(), { callId: created.id }));
  }
  const ceiling = ask(taskB);
  assert.equal(ceiling.decision, 'deny');
  assert.match(ceiling.decision === 'deny' ? ceiling.reason : '', /instance-wide/);
});

test('the per-org-unit limit is validated, and loosening it (raising or removing) is a risky policy change', () => {
  const withUnit = (n: string) => withPhone(PHONE_SECTION.replace('max_calls_per_day: 2', `max_calls_per_day: 5\n  max_calls_per_day_per_org_unit: ${n}`));
  assert.ok(!parsePolicy(withUnit('0')).ok);
  assert.ok(!parsePolicy(withUnit('1.5')).ok);
  const base = parse(withUnit('2')).document;
  assert.equal(classifyChange(base, parse(withUnit('3')).document).changeClass, 'risky');
  assert.equal(classifyChange(base, parse(withUnit('1')).document).changeClass, 'normal');
  assert.equal(classifyChange(base, parse(withPhone(PHONE_SECTION.replace('max_calls_per_day: 2', 'max_calls_per_day: 5'))).document).changeClass, 'risky', 'removing the per-unit limit widens');
  assert.equal(classifyChange(parse(withPhone(PHONE_SECTION.replace('max_calls_per_day: 2', 'max_calls_per_day: 5'))).document, base).changeClass, 'normal', 'adding a per-unit limit tightens');
});
