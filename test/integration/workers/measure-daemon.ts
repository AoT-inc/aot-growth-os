// 자식 프로세스: 정책 게이트·승인 엔진·측정 채널까지 조립한 "데몬" 하나 (apps/daemon/src/assemble.ts 와 같은 조립, A6-U13).
// 같은 DB 파일을 여는 데몬을 둘 띄울 때 승인 소켓은 하나만 연다(`channel` 인자). 실행기는 실행할 때마다 로그 파일에 한 줄을 남긴다.
// 시각은 부모가 IPC 로 정한다(가짜 시계): 측정 값의 기본 주(지난주)와 "끝난 주" 판정도 이 시각을 쓴다.
//
// 부모 → 자식: {cmd:'tick', now} | {cmd:'set', now}
// 자식 → 부모: {type:'ready', socket|null} | {type:'tick', report} | {type:'set'} | {type:'error', message}
import { appendFileSync } from 'node:fs';

import { FakeClock, openDb } from '@aot/domain';

import { assembleDaemon, defaultInstancePaths } from '../../../apps/daemon/src/assemble.ts';
import { manualTimers } from '../../support/engine.ts';
import { PACK_SIGNAL } from '../../support/measurement.ts';

const [dbPath, instanceDir, logPath, workerId, channelFlag] = process.argv.slice(2);
const db = openDb({ path: dbPath! });
const clock = new FakeClock(0);
const send = (message: unknown) => process.send?.(message);

const daemon = assembleDaemon({
  db, clock, paths: defaultInstancePaths(instanceDir!), workerId: workerId!, actorId: 'actor-agent-1', adapter: 'fake-adapter',
  timers: manualTimers(),
  measurementSignals: [PACK_SIGNAL],
  executor: {
    execute(context) {
      appendFileSync(logPath!, `${workerId!} ${context.taskId}\n`);
      return Promise.resolve({ result: { summary: 'example plan' } });
    },
  },
});
const channel = channelFlag === '1' ? await daemon.startApprovalChannel() : null;

process.on('message', (raw) => {
  const message = raw as { cmd: string; now: number };
  const run = async () => {
    clock.set(message.now);
    if (message.cmd === 'set') return send({ type: 'set' });
    send({ type: 'tick', report: await daemon.worker.tick() });
  };
  run().catch((error: unknown) => send({ type: 'error', message: error instanceof Error ? error.stack ?? error.message : String(error) }));
});

send({ type: 'ready', socket: channel?.socketPath ?? null });
