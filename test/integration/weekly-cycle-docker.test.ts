// A6-U17 통합: 주간 사이클을 실제 어댑터로 1회 — 1~3단계(루틴 슬롯 발화 → 조사 업무 → 검증)를 컨테이너 안 읽기 전용 조사 에이전트와 로컬 HTTP 서버로,
// 4~7단계(기획 → 비교 → 사람 승인 → 활성화 → 실험 주 종료 → 측정 입력 → 결과 검토 → 기록 → 승격)를 가짜 어댑터로 이어 끝까지 간다.
// 조사 쪽은 데몬 설정 → 조립(runtime-config.ts: container_agent + research_agent + llm_verifier stub)을 그대로 쓰고, 시험이 바꾸는 것은
// 외부 접근 부품의 시험용 주입점(이름 해석을 127.0.0.1 로 고정, 사설 주소 규칙에서 그 주소만 제외)과 가짜 LLM 검증기의 판정 규칙뿐이다(daemon-research-pipeline 과 같다).
// 팩 사본의 차이: 조사 업무에 `validation.llm`(weekly-cycle-fake 와 같음)과 `expected_quotes` — 실제 조사 에이전트는 기대 인용문만 확인하므로
// 출하 템플릿(기대 인용문 없음)으로는 주장이 없어 inconclusive 가 된다(phase-a A6 완료 기록의 열린 항목).
// 실행 중 컨테이너의 `Mounts` 가 비어 있고, 끝나면 이 시험 인스턴스의 `aot.run` 컨테이너가 0개다. docker 가 없거나 이미지를 빌드할 수 없으면 이유를 출력하고 skip 한다.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { cleanupOrphanContainers, type ToolCallRecord } from '@aot/agent-runtime';
import { findExperimentResult } from '@aot/domain';
import { createStubLlmVerifier } from '@aot/evaluation';

import { buildAgentRuntime } from '../../apps/daemon/src/runtime-config.ts';
import { createFetchUrlToolWithHooks, createSourceFetcherWithHooks, type FetchUrlHooks } from '../../packages/agent-runtime/src/fetch-url.ts';
import { dockerOut, TEST_INSTANCE, testContainers, waitUntilNoTestContainers } from '../support/container-sandbox.ts';
import { manualTimers, taskStatus } from '../support/engine.ts';
import { html, startPageServer } from '../support/page-server.ts';
import { AGENT, OWNER, policyEnv } from '../support/policy.ts';
import { prepareResearchAgent } from '../support/research-agent.ts';
import { assembleCycleDaemon, cyclePackCopy, enablePlanningRoutine, PACK_VALUES, SIGNAL_ID } from '../support/weekly-cycle.ts';

const prepared = await prepareResearchAgent();
if (!prepared.ok) console.log(`[weekly-cycle-docker] SKIPPED: ${prepared.reason}`);

const HOST = 'research.example.test';
const QUOTE = 'the quarterly price is fixed for all plans';
const FIRST_SEEN = '2026-10-25T16:00:00.000Z';
const SLOT_1 = '2026-10-26T00:00:00.000Z';
const W45_END = '2026-11-08T15:00:00.000Z';
const at = (iso: string, plusMs = 0) => new Date(Date.parse(iso) + plusMs).toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

if (!prepared.ok) {
  test('weekly cycle with the real research agent (real docker)', { skip: `weekly cycle docker test skipped: ${prepared.reason}` }, () => undefined);
} else {
  const sandbox = prepared.env;
  console.log(`[weekly-cycle-docker] docker ${sandbox.dockerVersion}, research agent image ${sandbox.imageId.slice(0, 19)}…, instance ${TEST_INSTANCE}`);

  test('the weekly cycle once with the real read-only research agent in a container (steps 1-3), then fake adapters through steps 4-7', async (t) => {
    const web = await startPageServer(t);
    t.after(() => cleanupOrphanContainers({ docker: sandbox.docker, instance: TEST_INSTANCE }));
    const PAGE_HTML = `<html><body><h1>Pricing notes</h1><p>As announced, ${QUOTE}.</p></body></html>`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    web.route('/market-news', (req, res) => void gate.then(() => html(PAGE_HTML)(req, res)));
    const sourceUrl = `http://${HOST}:${web.port}/market-news`;

    const env = policyEnv(t);
    env.db.writeTx((tx) => tx.run(
      "INSERT INTO product (id, slug, name, kind, lifecycle_stage, registration_status, created_at, updated_at) VALUES ('product-example-product', 'example-product', 'example-product', 'software', 'live', 'registered', ?, ?)",
      [env.clock.nowIso(), env.clock.nowIso()],
    ));
    const hooks: FetchUrlHooks = {
      exemptAddresses: ['127.0.0.1'],
      lookup: (host) => (host === HOST ? Promise.resolve([{ address: '127.0.0.1', family: 4 }]) : Promise.reject(new Error('ENOTFOUND'))),
    };
    const records: ToolCallRecord[] = [];
    const runtime = buildAgentRuntime({
      container_agent: { docker_path: sandbox.docker.path, memory_mib: 128, cpus: 0.5, pids_limit: 32, tmpfs_mib: 16 },
      research_agent: { image: sandbox.imageId, allowed_hosts: [HOST], fetch_unit_cost_usd: 0.0005 },
      instance_id: TEST_INSTANCE,
      run_log_dir: join(env.dir, 'run-logs'),
      default_time_limit: '2m',
      llm_verifier: { kind: 'stub', cost_usd: 0.001 },
    }, env.dir, {
      recorder: { record: (record) => void records.push(record) },
      createFetchUrlTool: (options) => createFetchUrlToolWithHooks(options, hooks),
      createSourceFetcher: (options) => createSourceFetcherWithHooks(options, hooks),
      // 실제 조사 에이전트의 주장 문장("The source … contains the quotation.")은 원문의 부분 문자열이 아니다: 검증기가 직접 읽은 원문에 인용문이 있으면 supported
      createLlmVerifier: (config) => createStubLlmVerifier({ costUsd: config.cost_usd ?? 0, rule: (_claim, source) => (source?.text?.includes(QUOTE) === true ? 'supported' : 'unsupported') }),
    });
    const packDir = cyclePackCopy(env.dir, (research) => {
      research['expected_quotes'] = [{ source: 'market-news', text: QUOTE }];
    });
    const daemon = assembleCycleDaemon({
      db: env.db, clock: env.clock, dir: env.dir, packDir, runtime, timers: manualTimers(),
      values: { ...PACK_VALUES, research_source_url: sourceUrl, research_host: HOST },
      paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    });
    const readiness = await daemon.prepareAgentRuntime();
    assert.equal(readiness?.dockerVersion, sandbox.dockerVersion, 'the container adapter is configured: docker is checked at start');
    enablePlanningRoutine(env.db);

    // ① 슬롯 발화 → ② 컨테이너 조사 (실행 중 들여다보기)
    env.clock.set(FIRST_SEEN);
    await daemon.worker.tick();
    env.clock.set(at(SLOT_1, 5_000));
    const ticking = daemon.worker.tick();
    await waitFor(() => web.requests.length > 0, 'the agent fetch to reach the local page server');
    await waitFor(async () => (await testContainers(sandbox.docker)).length === 1, 'the agent container of this test to be listed');
    const [containerId] = await testContainers(sandbox.docker);
    const inspected = (JSON.parse(await dockerOut(sandbox.docker, ['inspect', containerId!])) as { Mounts: unknown[]; HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean }; Config: { Labels: Record<string, string> } }[])[0]!;
    release();
    const fired = await ticking;
    assert.deepEqual(inspected.Mounts, [], 'Mounts is empty');
    assert.deepEqual([inspected.HostConfig.NetworkMode, inspected.HostConfig.ReadonlyRootfs, inspected.Config.Labels['aot.instance']], ['none', true, TEST_INSTANCE]);
    assert.deepEqual(fired.routines.fired.map((f) => [f.scheduledFor, f.taskIds.length]), [[SLOT_1, 2]]);
    const tasks = env.db.all<{ id: string; objective: string }>('SELECT id, objective FROM task ORDER BY created_at, rowid');
    const research = tasks.find((row) => row.objective.includes('지난 7일'))!.id;
    const plan = tasks.find((row) => row.objective.includes('실험 후보'))!.id;
    assert.deepEqual([fired.executed?.taskId, fired.executed?.end], [research, { outcome: 'submitted', taskStatus: 'validating' }]);
    assert.equal(env.db.get<{ adapter: string }>('SELECT adapter FROM task_run WHERE task_id = ?', [research])!.adapter, 'research-agent');
    assert.deepEqual(records.map((r) => [r.tool, r.outcome, r.decision]), [['fetch_url', 'ok', 'allow']]);
    assert.deepEqual(await waitUntilNoTestContainers(sandbox.docker), [], 'the container is gone after the run');

    // ③ 검증: 검증기가 출처를 직접 다시 읽고(결정론적 검사) 가짜 LLM 검증기가 판정한다
    env.clock.set(at(SLOT_1, 10_000));
    const validated = await daemon.worker.tick();
    assert.deepEqual(validated.validated.map((v) => [v.taskId, v.taskStatus]), [[research, 'completed']]);
    const evaluation = env.db.get<{ outcome: string; quality_note: string }>('SELECT outcome, quality_note FROM evaluation WHERE task_id = ?', [research])!;
    assert.equal(evaluation.outcome, 'pass', evaluation.quality_note);
    assert.match(evaluation.quality_note, /quote_in_source=pass/);
    assert.match(evaluation.quality_note, /stub-llm-verifier@v1: supported/);
    assert.deepEqual(env.db.all<{ trust_origin: string; verified: number }>("SELECT trust_origin, verified FROM evidence WHERE task_id = ? AND kind = 'source_url'", [research]).map((e) => [e.trust_origin, e.verified]), [['external_untrusted', 1]]);
    assert.equal(web.requests.length, 2, 'the agent read the page once through the gateway, the validator once itself');

    // ④ 기준선 입력 → 기획(가짜) ⑤ 비교 → 제안
    const measure = (week: string, value: number) => daemon.handleChannelRequest({
      cmd: 'measure', actor: OWNER, signal: SIGNAL_ID, week, value, observations: 3, quality: 'good', attachments: [{ ref: `file:/example/${week}.png`, sha256: 'd'.repeat(64) }], minutes: 5,
    }) as { ok: boolean };
    assert.equal(measure('2026-W43', 10).ok, true);
    env.clock.set(at(SLOT_1, 20_000));
    assert.equal((await daemon.worker.tick()).executed?.taskId, plan);
    env.clock.set(at(SLOT_1, 30_000));
    assert.deepEqual((await daemon.worker.tick()).validated.map((v) => [v.taskId, v.taskStatus]), [[plan, 'completed']]);
    const strategyId = (await daemon.cycle!.advance()).compared[0]!.strategyVersionId!;
    assert.ok(strategyId);

    // ⑥ 사람 승인 (에이전트 거부) → 활성화 → 마케팅 업무(가짜)
    const shown = daemon.handleChannelRequest({ cmd: 'show', actor: OWNER, kind: 'strategy_version', id: strategyId }) as { hash: string };
    assert.equal((daemon.handleChannelRequest({ cmd: 'approve', actor: AGENT, kind: 'strategy_version', id: strategyId, hash: shown.hash }) as { ok: boolean }).ok, false);
    assert.equal((daemon.handleChannelRequest({ cmd: 'approve', actor: OWNER, kind: 'strategy_version', id: strategyId, hash: shown.hash }) as { state: string }).state, 'experiment');
    const [marketing] = (await daemon.cycle!.advance()).activated[0]!.taskIds as [string];
    env.clock.set(at(SLOT_1, 40_000));
    assert.equal((await daemon.worker.tick()).executed?.taskId, marketing);

    // ⑦ 실험 주 종료 → 결과 검토 → 측정 입력 → 평가 → 기록 → 승격
    env.clock.set(W45_END);
    const review = (await daemon.cycle!.advance()).reviewsCreated[0]!.reviewTaskId;
    assert.equal(measure('2026-W45', 20).ok, true);
    for (let i = 1; i <= 3; i += 1) {
      env.clock.set(at(W45_END, i * 10_000));
      await daemon.worker.tick();
    }
    assert.equal(taskStatus(env.db, review), 'completed');
    const recorded = await daemon.cycle!.advance();
    assert.deepEqual(recorded.resultsRecorded.map((r) => [r.strategyVersionId, r.conclusion, r.recorded]), [[strategyId, 'pass', true]]);
    assert.equal(findExperimentResult(env.db, strategyId)!.totalCostUsd, Math.round(Number(env.db.get<{ s: number }>(
      'SELECT sum(amount_usd) AS s FROM cost_entry WHERE task_id IN (SELECT id FROM task WHERE strategy_version_id = ?)', [strategyId],
    )!.s) * 1e9) / 1e9);
    assert.equal((daemon.handleChannelRequest({ cmd: 'promote', actor: OWNER, kind: 'strategy_version', id: strategyId, comment: 'beat the pass line' }) as { status: string }).status, 'active');
    assert.deepEqual(env.db.all<{ kind: string }>('SELECT kind FROM memory_item WHERE strategy_version_id = ? ORDER BY kind', [strategyId]).map((m) => m.kind), ['measurement', 'strategy_record']);

    // 끝: 이 시험 인스턴스의 aot.run 컨테이너가 하나도 없다
    assert.deepEqual(await waitUntilNoTestContainers(sandbox.docker), []);
    assert.equal((await dockerOut(sandbox.docker, ['ps', '-aq', '--filter', 'label=aot.run', '--filter', `label=aot.instance=${TEST_INSTANCE}`])).trim(), '');
  });
}
