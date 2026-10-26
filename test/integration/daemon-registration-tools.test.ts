// 상품 등록 검증 도구를 데몬 조립(설정 → buildAgentRuntime → 게이트웨이 → 근거 저장 → 평가기)에서 끝까지:
//   에이전트(시험용 어댑터)가 게이트웨이로 도구 7개를 부르고, 호스트가 결과 본문을 근거 저장소에 쓰고 근거 행을 만들며, 평가기가 그 본문을 읽어 pass 를 낸다.
//   저장소 접근이 승인되지 않았거나 상품이 검증 중이 아니거나 명세가 저장소를 하나로 가리키지 않으면 도구가 열리지 않는다.
// 에이전트 계층의 실제 모델은 쓰지 않는다. 저장소는 실제 git, 스캐너는 가짜 gitleaks 실행 파일이다.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  registrationToolName, REPO_READ_TOOL, type AdapterContext, type AdapterOutput, type AgentAdapter, type JsonObject, type ToolGatewayResponse,
} from '@aot/agent-runtime';
import type { IsolatedVerificationInput, LlmVerdict, LlmVerifier } from '@aot/evaluation';

import { assembleDaemon } from '../../apps/daemon/src/assemble.ts';
import { buildAgentRuntime } from '../../apps/daemon/src/runtime-config.ts';
import { manualTimers, taskStatus } from '../support/engine.ts';
import { evaluationsOf, validationSpec } from '../support/evaluation.ts';
import { AGENT, createWithGate, policyEnv, readOnlyDraft, type PolicyEnv } from '../support/policy.ts';
import { writeFakeVerifierClaude, type FakeVerifierScenario } from '../support/fake-claude-verifier.ts';
import { GIT, makeRepo, writeStubGitleaks, type RepoFiles } from '../support/registration-tools.ts';
import { makeTempDir } from '../support/temp.ts';

const GITLEAKS_CONFIG = new URL('../../config/gitleaks-registration.toml', import.meta.url).pathname;
const CHECKS = ['schema_valid', 'evidence_refs_resolvable', 'no_secret_in_outputs', 'read_only_calls_only', 'scan_coverage_complete', 'classification_present', 'budget'];
const OPERATIONS: [string, string[]][] = [
  ['repo_read', ['list_tree', 'read_file', 'read_metadata', 'read_history']], ['secret_scan', ['scan_tree', 'scan_history']], ['license_check', ['identify']],
];
const FILES: RepoFiles = {
  'README.md': '# example-product\nA small command line tool.\n',
  'package.json': JSON.stringify({ name: 'example-product', license: 'MIT' }),
  'src/index.ts': 'export const x = 1;\n',
  'LICENSE': 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.\nTHE SOFTWARE IS PROVIDED "AS IS".\n',
};

const allowedTools = (target: string) => OPERATIONS.map(([tool, operations]) => ({ tool, operations, scope: 'internal', impact: 'read', target }));

class ScriptedLlm implements LlmVerifier {
  readonly id = 'scripted-verifier@v1';
  readonly inputs: IsolatedVerificationInput[] = [];
  verify(input: IsolatedVerificationInput): Promise<LlmVerdict> {
    this.inputs.push(input);
    return Promise.resolve({ verdict: 'supported', note: 'the claims match the stored evidence' });
  }
}

interface CallRecord { name: string; ok: boolean; error?: string }

/** 에이전트 역할의 어댑터: 게이트웨이로 도구를 불러 근거 id 를 모으고, 그 id 를 인용한 registration-report@1 을 낸다 */
function scriptedAgent(calls: CallRecord[]): AgentAdapter {
  return {
    name: 'scripted-agent',
    async run(_input, context: AdapterContext): Promise<AdapterOutput> {
      const call = async (tool: string, operation: string, args: JsonObject = {}): Promise<JsonObject | null> => {
        const name = registrationToolName(tool, operation);
        const response: ToolGatewayResponse = await context.gateway.call(name, args);
        calls.push({ name, ok: response.ok, ...(response.ok ? {} : { error: response.error }) });
        return response.ok ? (response.result as JsonObject) : null;
      };
      const tree = await call('repo_read', 'list_tree', { depth: 2 });
      const readme = await call('repo_read', 'read_file', { path: 'README.md' });
      const meta = await call('repo_read', 'read_metadata');
      const history = await call('repo_read', 'read_history');
      const scanTree = await call('secret_scan', 'scan_tree');
      const scanHistory = await call('secret_scan', 'scan_history');
      const license = await call('license_check', 'identify');
      if ([tree, readme, meta, history, scanTree, scanHistory, license].some((result) => result === null)) {
        return { status: 'error', result: null, evidence: [], run_log: [], cost: { tokens: 0 }, error: { code: 'tool_failed', message: 'a tool call was refused' } };
      }
      const id = (result: JsonObject | null): string => String(result!['evidence_id']);
      const collected = (item: string, ...ids: string[]) => ({ item, status: 'collected', evidence_ids: ids });
      const report = {
        claims: [{ id: 'c1', statement: 'The README describes a small command line tool.', evidence_id: id(readme) }],
        collection: [
          collected('repo_structure', id(tree)), collected('stack', id(meta)), collected('readme_summary', id(readme)),
          { item: 'remote', status: 'unavailable', reason: 'the repository has no remote configured' },
          collected('default_branch', id(meta)), collected('activity_history', id(history)), collected('license', id(license)),
          { item: 'environment', status: 'unavailable', reason: 'no environment names appear in the documentation' },
          collected('secret_scan', id(scanTree), id(scanHistory)),
        ],
        classification: { proposal: 'internal', rationale_evidence_ids: [id(license)] },
        uncertainties: [],
      };
      return { status: 'submitted', result: report as unknown as JsonObject, evidence: [], run_log: [], cost: { tokens: 100 } };
    },
  };
}

interface Setup { env: PolicyEnv; root: string; evidenceDir: string; calls: CallRecord[]; llm: ScriptedLlm; daemon: ReturnType<typeof assembleDaemon>; productId: string; verifierRecordPath: string | null }

const CONSENT = { notice_version: 'notice-1', accepted_at: '2026-10-26T00:00:00.000Z' };

/** `verifier` 를 주면 검증기는 설정의 `llm_verifier: claude_code_cli` 로 만든다(가짜 claude 실행 파일). 안 주면 시험용 `ScriptedLlm` 을 끼운다 */
function setup(t: TestContext, options: { accessScope?: string; status?: string; scenario?: Parameters<typeof writeStubGitleaks>[1]; verifier?: FakeVerifierScenario } = {}): Setup {
  const env = policyEnv(t);
  const root = makeRepo(t, FILES);
  const dir = makeTempDir(t, 'aot-reg-');
  const scanner = writeStubGitleaks(dir, options.scenario ?? { kind: 'clean' });
  const evidenceDir = join(dir, 'evidence');
  const productId = 'p-example-product';
  env.db.writeTx((tx) => {
    tx.run(
      'INSERT INTO product (id, slug, name, kind, lifecycle_stage, registration_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [productId, 'example-product', 'example-product', 'software', 'live', options.status ?? 'verifying', env.clock.nowIso(), env.clock.nowIso()],
    );
    tx.run('INSERT INTO product_repo (id, product_id, name, local_path, access_scope) VALUES (?, ?, ?, ?, ?)', ['repo-1', productId, 'main', root, options.accessScope ?? 'read']);
  });
  const fakeVerifier = options.verifier === undefined ? null : writeFakeVerifierClaude(dir, options.verifier);
  const built = buildAgentRuntime(
    {
      claude_code_cli: {
        claude_path: fakeVerifier?.path ?? '/opt/example/bin/claude', run_root: join(dir, 'r'),
        env: { home: dir, user: 'example-daemon', path: `${process.execPath.replace(/\/node$/, '')}:/usr/bin:/bin` }, model: 'executor-alias',
      },
      registration_tools: { git_path: GIT, gitleaks_path: scanner.path, gitleaks_config: GITLEAKS_CONFIG, evidence_dir: evidenceDir },
      ...(fakeVerifier === null ? {} : { llm_verifier: { kind: 'claude_code_cli' as const, model: 'verifier-alias' } }),
    },
    dir,
    { db: env.db, clock: env.clock, claudeCodeConsent: () => (fakeVerifier === null ? null : CONSENT) },
  );
  assert.ok(built.agent && built.evaluation?.evidenceReader, 'the registration tools and the evidence reader are wired from the settings');
  const calls: CallRecord[] = [];
  const llm = new ScriptedLlm();
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    agent: { ...built.agent, adapter: scriptedAgent(calls) },
    evaluation: fakeVerifier === null ? { ...built.evaluation, llm } : built.evaluation,
  });
  return { env, root, evidenceDir, calls, llm, daemon, productId, verifierRecordPath: fakeVerifier?.recordPath ?? null };
}

const registrationDraft = (target = 'repo:example-product', n = 1) => readOnlyDraft({
  ...validationSpec(CHECKS, { llm: { check: 'summary_supported_by_evidence', isolated_context: true }, human: true }),
  allowed_tools: allowedTools(target),
  inputs: [{ name: 'k', ref: `r:registration-${n}`, kind: 'k' }],
});

test('end to end: the agent calls the seven tools, the host stores the results as evidence, the evaluator reads them back and passes the task to the human', async (t) => {
  const { env, evidenceDir, calls, llm, daemon } = setup(t);
  const taskId = createWithGate(env, registrationDraft());
  const run = await daemon.worker.tick();
  assert.equal(run.executed?.end !== 'lease_lost' && run.executed?.end.taskStatus, 'validating', JSON.stringify(calls.filter((c) => !c.ok)));
  assert.deepEqual(calls.map((call) => call.name), [
    'repo_read_list_tree', 'repo_read_read_file', 'repo_read_read_metadata', 'repo_read_read_history', 'secret_scan_scan_tree', 'secret_scan_scan_history', 'license_check_identify',
  ]);
  assert.ok(calls.every((call) => call.ok));

  // 호스트가 만든 근거 행 7개: 본문 해시·저장소 참조·신뢰 출처, 본문은 0600 파일
  const rows = env.db.all<{ id: string; kind: string; ref: string; content_hash: string; trust_origin: string; verified: number }>('SELECT * FROM evidence WHERE task_id = ? ORDER BY captured_at, id', [taskId]);
  assert.equal(rows.length, 7);
  assert.ok(rows.every((row) => row.kind === 'document' && row.trust_origin === 'external_untrusted' && row.ref === `blob:sha256:${row.content_hash}`));
  assert.deepEqual(readdirSync(evidenceDir).sort(), [...new Set(rows.map((row) => row.content_hash))].sort());
  for (const file of readdirSync(evidenceDir)) assert.equal(statSync(join(evidenceDir, file)).mode & 0o777, 0o600);
  assert.equal(statSync(evidenceDir).mode & 0o777, 0o700);

  const checked = await daemon.worker.tick();
  assert.deepEqual(checked.validated.map((v) => v.taskStatus), ['needs_review'], JSON.stringify(env.db.get('SELECT quality_note FROM evaluation WHERE task_id = ?', [taskId])));
  assert.equal(evaluationsOf(env.db, taskId)[0]?.outcome, 'pass');
  assert.equal(evaluationsOf(env.db, taskId)[0]?.safety, 'pass');
  assert.equal(env.db.get("SELECT COUNT(*) AS n FROM evidence WHERE task_id = ? AND verified = 1", [taskId])?.['n'], rows.length, 'the evaluator verified every stored body against its recorded hash');
  // 검증기는 README 본문을 근거 주장의 출처로 받는다
  const [claim] = llm.inputs[0]?.claims ?? [];
  assert.ok(claim && rows.some((row) => `evidence:${row.id}` === claim.sourceRef), 'the claim cites one of the stored evidence rows');
  const source = llm.inputs[0]?.sources.find((candidate) => candidate.ref === claim?.sourceRef);
  assert.match(source?.text ?? '', /A small command line tool/);
  assert.equal(source?.trustOrigin, 'external_untrusted');
  // 읽기 호출만 판정에 남았다
  const impacts = env.db.all<{ impact: string; action: string }>("SELECT DISTINCT impact, action FROM policy_decision WHERE task_id = ? AND task_run_id IS NOT NULL", [taskId]);
  assert.ok(impacts.length >= 7 && impacts.every((row) => row.impact === 'read'));
  assert.ok(impacts.some((row) => row.action === 'repo_read.read_file'), 'the policy action is <tool>.<operation>, not the agent-facing name');
});

test('a stored body that is changed afterwards no longer matches its recorded hash: the evaluation is not a pass', async (t) => {
  const { env, evidenceDir, daemon } = setup(t);
  const taskId = createWithGate(env, registrationDraft());
  await daemon.worker.tick();
  const row = env.db.get<{ content_hash: string }>("SELECT content_hash FROM evidence WHERE task_id = ? AND ref LIKE 'blob:%' ORDER BY captured_at, id LIMIT 1 OFFSET 1", [taskId])!;
  const path = join(evidenceDir, row.content_hash);
  const { chmodSync, writeFileSync } = await import('node:fs');
  chmodSync(path, 0o600);
  writeFileSync(path, `${readFileSync(path, 'utf8')} (edited after the run)`);
  const checked = await daemon.worker.tick();
  assert.deepEqual(checked.validated.map((v) => v.taskStatus), ['retry_wait']);
  assert.equal(evaluationsOf(env.db, taskId)[0]?.outcome, 'fail');
  assert.match(String(env.db.get('SELECT quality_note FROM evaluation WHERE task_id = ?', [taskId])?.['quality_note']), /does not match the recorded content hash/);
});

test('the tools stay closed unless read access was approved and the product is under verification', async (t) => {
  for (const [label, options] of [
    ['access not granted', { accessScope: 'none' }],
    ['product not under verification', { status: 'candidate' }],
  ] as const) {
    const { env, calls, daemon } = setup(t, options);
    const taskId = createWithGate(env, registrationDraft());
    const run = await daemon.worker.tick();
    assert.ok(calls.length >= 1 && calls.every((call) => !call.ok), label);
    assert.equal(env.db.get('SELECT COUNT(*) AS n FROM evidence WHERE task_id = ?', [taskId])?.['n'], 0, `${label}: no evidence was created`);
    assert.notEqual(run.executed?.end !== 'lease_lost' && run.executed?.end.taskStatus, 'validating', label);
  }
});

test('the task must point at exactly one repository; the agent never supplies a path', async (t) => {
  const { env, calls, daemon } = setup(t);
  // 도구마다 다른 저장소를 가리키는 명세 / 대상 없음
  const split = registrationDraft();
  (split['allowed_tools'] as { target: string }[])[0]!.target = 'repo:another-product';
  const none = registrationDraft('mailbox:example', 2);
  for (const spec of [split, none]) {
    const before = calls.length;
    const taskId = createWithGate(env, spec);
    await daemon.worker.tick();
    assert.ok(calls.length > before && calls.slice(before).every((call) => !call.ok), 'every call was refused');
    assert.equal(env.db.get('SELECT COUNT(*) AS n FROM evidence WHERE task_id = ?', [taskId])?.['n'], 0);
    assert.notEqual(taskStatus(env.db, taskId), 'validating');
  }
  assert.equal(registrationToolName(REPO_READ_TOOL, 'read_file'), 'repo_read_read_file');
});

// ----- 구독 검증기(llm_verifier: claude_code_cli)로 끝까지: 가짜 claude 실행 파일이 도구 없는 별도 호출을 대신한다 -----

test('claude_code_cli verifier from the settings: the evaluator passes stored evidence to it, its verdict decides, and its tokens go to the ledger', async (t) => {
  const { env, verifierRecordPath, daemon } = setup(t, { verifier: { default: 'supported' } });
  const taskId = createWithGate(env, registrationDraft());
  await daemon.worker.tick();
  const checked = await daemon.worker.tick();
  assert.deepEqual(checked.validated.map((v) => v.taskStatus), ['needs_review']);
  assert.equal(evaluationsOf(env.db, taskId)[0]?.outcome, 'pass');
  const note = String(env.db.get('SELECT quality_note FROM evaluation WHERE task_id = ?', [taskId])?.['quality_note']);
  assert.match(note, /claude-code-cli-verifier@v1:verifier-alias: supported/);
  assert.match(note, /\[verifier tokens: 15, \d+% of the run's 100\]/);
  const ledger = env.db.all<{ units: string; amount_usd: number }>('SELECT units, amount_usd FROM cost_entry WHERE task_id = ?', [taskId]).map((row) => ({ units: JSON.parse(row.units) as Record<string, unknown>, usd: Number(row.amount_usd) }));
  assert.deepEqual(ledger.filter((entry) => entry.units['source'] === 'validation').map((entry) => [entry.units['tokens'], entry.usd]), [[15, 0]]);
  // 검증기 호출 모양: 도구 없음, 프롬프트(저장된 README 본문 포함)는 stdin
  const record = JSON.parse(readFileSync(verifierRecordPath!, 'utf8')) as { args: string[]; stdin: string };
  assert.equal(record.args[record.args.indexOf('--tools') + 1], '');
  assert.equal(record.args[record.args.indexOf('--model') + 1], 'verifier-alias');
  assert.match(record.stdin, /A small command line tool/);
});

test('claude_code_cli verifier: an unsupported claim fails the evaluation (the run goes back for retry)', async (t) => {
  const { env, daemon } = setup(t, { verifier: { default: 'unsupported' } });
  const taskId = createWithGate(env, registrationDraft());
  await daemon.worker.tick();
  const checked = await daemon.worker.tick();
  assert.deepEqual(checked.validated.map((v) => v.taskStatus), ['retry_wait']);
  assert.equal(evaluationsOf(env.db, taskId)[0]?.outcome, 'fail');
});

test('claude_code_cli verifier hitting the usage limit: the task stays validating without an evaluation, and later ticks do not start the CLI again', async (t) => {
  const { env, verifierRecordPath, daemon } = setup(t, { verifier: { limit: true } });
  const taskId = createWithGate(env, registrationDraft());
  await daemon.worker.tick();
  const first = await daemon.worker.tick();
  assert.equal(first.validated.length, 0);
  assert.equal(first.validationFailed.length, 1);
  assert.match(first.validationFailed[0]!.error, /^usage_limit:/);
  assert.equal(taskStatus(env.db, taskId), 'validating');
  assert.equal(evaluationsOf(env.db, taskId).length, 0);
  const before = readFileSync(verifierRecordPath!, 'utf8');
  const again = await daemon.worker.tick();
  assert.match(again.validationFailed[0]!.error, /not retried before/);
  assert.equal(readFileSync(verifierRecordPath!, 'utf8'), before, 'the CLI was not started again');
  assert.equal(env.db.get('SELECT COUNT(*) AS n FROM task_run WHERE task_id = ?', [taskId])?.['n'], 1, 'no new attempt was consumed');
});
