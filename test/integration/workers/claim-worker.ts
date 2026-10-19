// 자식 프로세스: 같은 SQLite 파일의 항목을 다른 프로세스와 경쟁해 선점한다.
// 도메인 로직이 아니라 "다중 프로세스 쓰기" 예제다 (lease 획득의 형태: 조건부 UPDATE + 같은 트랜잭션의 부수 기록).
import { openDb, systemClock } from '@aot/domain';

const [dbPath, workerId, itemCountText, startAtText] = process.argv.slice(2);
const itemCount = Number(itemCountText);
const startAt = Number(startAtText);

const db = openDb({ path: dbPath! });
const won: number[] = [];
const errors: string[] = [];

// 모든 프로세스가 같은 시각에 출발하도록 대기해 충돌을 유도한다 (spin).
while (Date.now() < startAt) {
  /* spin */
}

for (let id = 1; id <= itemCount; id += 1) {
  try {
    db.writeTx((tx) => {
      const claimed = tx.run('UPDATE claim_item SET owner = ?, claimed_at = ? WHERE id = ? AND owner IS NULL', [
        workerId!,
        systemClock.nowIso(),
        id,
      ]);
      if (claimed.changes === 1) {
        tx.run('UPDATE claim_counter SET n = n + 1');
        won.push(id);
      }
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}

db.close();
process.send?.({ workerId, won, errors });
