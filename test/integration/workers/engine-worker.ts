// 자식 프로세스: 실제 TaskWorker 를 돌리는 "데몬" 하나. 시각은 부모가 IPC 로 정한다(가짜 시계) — 결정적으로 시험하기 위해서다.
// heartbeat 타이머는 수동이라 저절로 돌지 않는다(부모가 시각을 움직여 lease 만료를 만든다).
//
// 부모 → 자식: {cmd:'tick', now} | {cmd:'drain', now} | {cmd:'continue'} | {cmd:'exit'}
// 자식 → 부모: {type:'ready'} | {type:'tick', report} | {type:'drained', executed} | {type:'blocked', taskId, attempt}
//              | {type:'delivered', taskId} | {type:'dispatched'} | {type:'error', message}
// routineTemplate 가 켜져 있으면 tick 이 도래한 루틴 슬롯을 발화한다 (tick 보고의 routines).
import { appendFileSync } from 'node:fs';

import { FakeClock, openDb } from '@aot/domain';
import { TaskWorker, type EffectTool, type TaskExecutor } from '@aot/task-engine';

import { ALLOW_ALL_GATE, asEffectTool, manualTimers } from '../../support/engine.ts';
import { fakeTemplateSource, threeStepTemplate } from '../../support/routine-template.ts';
import { createIdempotentFakeTool, createNonIdempotentFakeTool } from '../../support/fake-tool.ts';

interface EngineWorkerConfig {
  /** complete: 바로 결과 제출 / block: 시작 후 continue 를 기다림 / effect: 외부 부작용 1건 수행 후 제출 */
  executor: 'complete' | 'block' | 'effect';
  logPath: string;
  tool?: 'idempotent' | 'plain';
  toolStore?: string;
  /** effect: 전달 직후 응답 전에 멈춘다 (부모가 SIGKILL 한다) */
  blockAfterDelivery?: boolean;
  /** 멱등 도구의 키 보존 기간(ms). 기본 24h */
  retentionMs?: number;
  /** effect: dispatched 기록 직후, 가짜 도구를 부르기 전에 멈춘다 (부모가 SIGKILL 하면 dispatched + 전달 0건) */
  blockAfterDispatch?: boolean;
  /** effect: 부작용 전에 멈춘다 (그 사이 lease 를 잃게 한다) */
  blockBeforeEffect?: boolean;
  /** true 면 루틴 발화를 켠다: `weekly-research@1` 템플릿 = 의존이 있는 업무 3개 (가짜 RoutineTemplateSource) */
  routineTemplate?: boolean;
  leaseMs: number;
  heartbeatMs: number;
}

const EFFECT_STEP = { stepId: 'notify', action: 'send', target: 'mailbox:example', request: { subject: 'example-product weekly' } };

const [dbPath, workerId, configText] = process.argv.slice(2);
const config = JSON.parse(configText!) as EngineWorkerConfig;
const db = openDb({ path: dbPath! });
const clock = new FakeClock(0);

let release: (() => void) | undefined;
const waitForContinue = () => new Promise<void>((resolve) => {
  release = resolve;
});
const send = (message: unknown) => process.send?.(message);
const log = (line: string) => appendFileSync(config.logPath, `${line}\n`);

const tools: Record<string, EffectTool> = {};
if (config.tool) {
  const fake = config.tool === 'idempotent'
    ? createIdempotentFakeTool({
      name: 'notify-tool', ...(config.toolStore ? { storePath: config.toolStore } : {}), ...(config.retentionMs === undefined ? {} : { retentionMs: config.retentionMs }),
    })
    : createNonIdempotentFakeTool({ name: 'notify-tool', ...(config.toolStore ? { storePath: config.toolStore } : {}) });
  tools[fake.name] = asEffectTool(fake, {
    // beginDispatch 가 dispatched 를 커밋한 뒤, 전달 전에 불린다
    beforeSend: async (call) => {
      log(`send\t${call.effectKey}\t${workerId}`);
      if (!config.blockAfterDispatch) return;
      send({ type: 'dispatched' });
      await waitForContinue();
    },
    afterDelivery: async () => {
      if (!config.blockAfterDelivery) return;
      send({ type: 'delivered' });
      await waitForContinue();
    },
  });
}

const executor: TaskExecutor = {
  async execute(context) {
    log(`start\t${context.taskId}\t${workerId}\t${context.attempt}`);
    if (config.executor === 'block' || config.blockBeforeEffect) {
      send({ type: 'blocked', taskId: context.taskId, attempt: context.attempt });
      await waitForContinue();
    }
    let effect: unknown = null;
    if (config.executor === 'effect') effect = await context.performEffect('notify-tool', EFFECT_STEP);
    log(`done\t${context.taskId}\t${workerId}\t${context.attempt}`);
    return { result: { by: workerId, effect } };
  },
};

const worker = new TaskWorker({
  db, clock, workerId: workerId!, actorId: 'actor-agent-1', adapter: 'fake-adapter', executor, gate: ALLOW_ALL_GATE, tools,
  timers: manualTimers(), lease: { leaseMs: config.leaseMs, heartbeatMs: config.heartbeatMs },
  ...(config.routineTemplate ? { routines: { source: fakeTemplateSource({ 'weekly-research@1': threeStepTemplate }) } } : {}),
});

process.on('message', (raw) => {
  const message = raw as { cmd: string; now?: number };
  const run = async () => {
    switch (message.cmd) {
      case 'tick':
        clock.set(message.now!);
        send({ type: 'tick', report: await worker.tick() });
        break;
      case 'drain': {
        clock.set(message.now!);
        let executed = 0;
        while ((await worker.tick()).executed) executed += 1;
        send({ type: 'drained', executed });
        break;
      }
      case 'continue':
        release?.();
        break;
      case 'exit':
        db.close();
        process.exit(0);
    }
  };
  run().catch((error: unknown) => send({ type: 'error', message: error instanceof Error ? error.stack ?? error.message : String(error) }));
});

send({ type: 'ready' });
