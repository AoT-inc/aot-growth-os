// 읽기 전용 로컬 검토 화면 (docs/operations/review-web.md): 사람이 결정할 것을 쉬운 말·그래프·원본 증거로 보여 준다. 결정은 승인 CLI 명령을 직접 실행한다.
//   node apps/daemon/src/review-web.ts --db <path> [--port N] [--evidence-root <dir> ...]      (npm run review-web -- --db instance/demo/review.db)
//   DB 는 읽기 전용으로 열고 127.0.0.1 에만 묶는다. 위치 결정 규칙은 review-web/config.ts 머리말.
import { createReviewContext } from './review-web/context.ts';
import { parseReviewWebArgs, USAGE, UsageError } from './review-web/config.ts';
import { openReadOnlyDb } from './review-web/read-only-db.ts';
import { startReviewServer } from './review-web/server.ts';

async function main(): Promise<void> {
  const config = parseReviewWebArgs(process.argv.slice(2));
  const db = openReadOnlyDb(config.dbPath);
  const ctx = createReviewContext({ db, policyStoreDir: config.policyStoreDir, evidenceDir: config.evidenceDir, evidenceRoots: config.evidenceRoots });
  const server = await startReviewServer(ctx, { port: config.port, host: config.host });
  process.stdout.write(`검토 화면(읽기 전용): ${server.tokenUrl}\n(이 주소로 처음 한 번 들어온다. 토큰은 다시 찍지 않는다)\n`);
  const stop = (): void => {
    void server.close().then(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

try {
  await main();
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`review-web: ${error.message}\n${USAGE}`);
    process.exit(2);
  }
  console.error(`review-web: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
