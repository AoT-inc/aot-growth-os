// gitleaks 실행 래퍼. 항상 --redact (출력에 값 원문을 남기지 않는다), 설정은 .gitleaks.toml.
//   node scripts/scan-secrets.mjs dir      작업 트리 스캔 (npm run scan:secrets, CI)
//   node scripts/scan-secrets.mjs git      커밋 이력 스캔 (npm run scan:history, 공개 전 검사)
//   node scripts/scan-secrets.mjs staged   스테이징된 변경만 (커밋 전 훅)
// 인스턴스별 금지어 목록은 저장소 밖에 두고, 있으면 같은 방식으로 한 번 더 돌린다:
//   AOT_BANNED_CONFIG=<파일 경로>  또는  instance/gitleaks-banned.toml (gitignore 대상)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
const MODES = {
  dir: ['dir', '.'],
  git: ['git', '.'],
  staged: ['git', '--pre-commit', '--staged', '.'],
};

if (!(mode in MODES)) {
  console.error(`usage: scan-secrets.mjs <${Object.keys(MODES).join('|')}>`);
  process.exit(2);
}

function scan(label, configPath) {
  const [subcommand, ...rest] = MODES[mode];
  const args = [subcommand, '--config', configPath, '--redact', '--no-banner', '--log-level', 'warn', '--exit-code', '3', ...rest];
  const result = spawnSync('gitleaks', args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(`gitleaks not found or failed to start (${result.error.message}). Install gitleaks 8.30.1 and retry.`);
    return 2;
  }
  console.error(`${label}: ${result.status === 0 ? 'no leaks found' : `exit ${result.status}`}`);
  return result.status ?? 2;
}

let status = scan('secret scan (gitleaks)', join(root, '.gitleaks.toml'));

const banned = process.env.AOT_BANNED_CONFIG ?? join(root, 'instance', 'gitleaks-banned.toml');
if (existsSync(banned)) {
  status = scan('banned-word scan', banned) || status;
} else {
  console.error('banned-word scan: skipped (no list; set AOT_BANNED_CONFIG or create instance/gitleaks-banned.toml)');
}
process.exit(status);
