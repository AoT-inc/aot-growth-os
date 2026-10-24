// 자식 프로세스: 주간 사이클 데몬 하나 (test/support/weekly-cycle.ts 의 조립 = apps/daemon/src/assemble.ts + 팩 사본 + 업무별 가짜 어댑터, A6-U17).
// `hang` 이면 조사 어댑터가 시작한 뒤 끝나지 않는다(부모가 SIGKILL 한다). 시각은 부모가 IPC 로 정한다(가짜 시계).
//
// 부모 → 자식: {cmd:'tick', now}
// 자식 → 부모: {type:'ready'} | {type:'tick', report} | {type:'error', message}
import { join } from 'node:path';

import { FakeClock, openDb } from '@aot/domain';

import { defaultInstancePaths } from '../../../apps/daemon/src/assemble.ts';
import { assembleCycleDaemon } from '../../support/weekly-cycle.ts';

const [dbPath, instanceDir, packDir, workerId, mode] = process.argv.slice(2);
const db = openDb({ path: dbPath! });
const clock = new FakeClock(0);
const send = (message: unknown) => process.send?.(message);

const daemon = assembleCycleDaemon({
  db, clock, dir: join(instanceDir!, 'work'), packDir: packDir!, workerId: workerId!, paths: defaultInstancePaths(instanceDir!), hangResearch: mode === 'hang',
});

process.on('message', (raw) => {
  const message = raw as { cmd: string; now: number };
  const run = async () => {
    clock.set(message.now);
    send({ type: 'tick', report: await daemon.worker.tick() });
  };
  run().catch((error: unknown) => send({ type: 'error', message: error instanceof Error ? error.stack ?? error.message : String(error) }));
});

send({ type: 'ready' });
