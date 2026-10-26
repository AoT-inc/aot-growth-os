// 자식 프로세스: 쓰기 트랜잭션을 연 채로 멈춘다. 부모가 SIGKILL 로 죽인다.
import { openDb } from '@aot/domain';

const db = openDb({ path: process.argv[2]! });
db.writeTx((tx) => {
  tx.run("INSERT INTO claim_item (id, owner) VALUES (999, 'doomed')");
  process.send?.('locked');
  // 트랜잭션을 연 채 동기 대기 (이벤트 루프를 막는다)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
});
