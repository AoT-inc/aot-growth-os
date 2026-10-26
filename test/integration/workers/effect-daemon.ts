// 자식 프로세스: 정책 게이트·승인 엔진·승인 소켓(효과 해소 채널 포함)까지 조립한 "데몬" 하나 (apps/daemon/src/assemble.ts 와 같은 조립).
// 외부 도구는 멱등 키가 없는 가짜 도구라 응답을 잃으면 재전송 없이 `unknown` 이 된다. 전달 기록은 파일(JSON lines)이라 부모가 센다.
// 실행기는 업무마다 같은 단계('notify') 하나를 수행한다. 요청 본문에는 구별되는 표식이 들어 있어 부모가 어디에도 새지 않음을 본다.
// 시각은 부모가 IPC 로 정한다(가짜 시계): 승인 엔진의 cooldown·TOTP 시간창도 이 시각을 쓴다.
//
// 부모 → 자식: {cmd:'set', now} | {cmd:'tick', now} | {cmd:'lose', count} | {cmd:'exit'}
// 자식 → 부모: {type:'ready', socket} | {type:'set'} | {type:'tick', report} | {type:'lose'} | {type:'error', message}
import { FakeClock, openDb } from '@aot/domain';
import type { EffectTool } from '@aot/task-engine';

import { assembleDaemon, defaultInstancePaths } from '../../../apps/daemon/src/assemble.ts';
import { asEffectTool, manualTimers } from '../../support/engine.ts';
import { createNonIdempotentFakeTool } from '../../support/fake-tool.ts';

/** 요청 본문에만 있는 표식 (부모 시험과 같은 값) */
const BODY_MARKER = 'BODY-MARKER-77d1c2e0';

const [dbPath, instanceDir, toolStore] = process.argv.slice(2);
const db = openDb({ path: dbPath! });
const clock = new FakeClock(0);
const send = (message: unknown) => process.send?.(message);

const fake = createNonIdempotentFakeTool({ name: 'notify-tool', storePath: toolStore! });
const tools: Record<string, EffectTool> = { 'notify-tool': asEffectTool(fake) };
const daemon = assembleDaemon({
  db, clock, paths: defaultInstancePaths(instanceDir!), workerId: 'daemon-1', actorId: 'actor-agent-1', adapter: 'fake-adapter', tools,
  timers: manualTimers(),
  executor: {
    async execute(context) {
      const outcome = await context.performEffect('notify-tool', { stepId: 'notify', action: 'send', target: 'mailbox:example', request: { subject: 'example-product weekly', body: BODY_MARKER } });
      return { result: outcome };
    },
  },
});
const channel = await daemon.startApprovalChannel();

process.on('message', (raw) => {
  const message = raw as { cmd: string; now?: number; count?: number };
  const run = async () => {
    switch (message.cmd) {
      case 'set':
        clock.set(message.now!);
        send({ type: 'set' });
        break;
      case 'lose':
        fake.loseNextResponses(message.count ?? 1);
        send({ type: 'lose' });
        break;
      case 'tick':
        clock.set(message.now!);
        send({ type: 'tick', report: await daemon.worker.tick() });
        break;
      case 'exit':
        await channel.close();
        db.close();
        process.exit(0);
    }
  };
  run().catch((error: unknown) => send({ type: 'error', message: error instanceof Error ? error.stack ?? error.message : String(error) }));
});

send({ type: 'ready', socket: channel.socketPath });
