// 사람용 승인 CLI (trust-boundaries §3.1). 데몬의 승인 엔진과 Unix 도메인 소켓으로만 통신한다. DB 를 직접 열지 않는다.
//   node apps/daemon/src/approve.ts [--socket PATH] [--actor ID] <명령>
//     whoami | list
//     show    <task|publication|policy_version> <id>
//     approve <task|publication> <id> --hash <show 가 보여 준 해시> [--comment 글]
//     approve policy --file <정책.yaml> [--comment 글]          (배포 승인. 위험 변경이면 cooldown 뒤 release)
//     release <task|publication|policy_version> <id> [--totp-stdin]   (TOTP 코드는 표준 입력 한 줄로 받는다)
//     cancel  <task|publication|policy_version> <id> [--comment 글]   (cooldown 중 취소)
//     reject  <task|publication|policy_version> <id> [--comment 글]
//     totp-enroll [--totp-dir DIR]   (이 기기에서 실행. 비밀을 instance/totp/<actor> 에 0600 으로 만들고 등록 URI 를 한 번 보여 준다)
// 기본값: --socket = $AOT_APPROVAL_SOCKET 또는 $AOT_INSTANCE_DIR/run/approval.sock, --actor = $AOT_ACTOR
// TOTP 코드는 명령줄 인자로 받지 않는다(프로세스 목록에 보이므로).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { otpauthUri, sendApprovalRequest, TotpSecretStore } from '@aot/policy';

const KINDS = ['task', 'publication', 'policy_version'] as const;

function fail(message: string): never {
  console.error(`aot-approve: ${message}`);
  process.exit(2);
}

function parseArgs(argv: string[]): { flags: Map<string, string | true>; positional: string[] } {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === 'totp-stdin') flags.set(name, true);
    else if (i + 1 < argv.length) flags.set(name, argv[(i += 1)]!);
    else fail(`--${name} needs a value`);
  }
  return { flags, positional };
}

async function readStdinLine(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) {
    data += String(chunk);
    if (data.includes('\n')) break;
  }
  return data.split('\n')[0]!.trim();
}

async function main(): Promise<void> {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const instance = process.env['AOT_INSTANCE_DIR'] ?? 'instance';
  const flag = (name: string): string | undefined => {
    const value = flags.get(name);
    return typeof value === 'string' ? value : undefined;
  };
  const actor = flag('actor') ?? process.env['AOT_ACTOR'] ?? fail('--actor (or AOT_ACTOR) is required');
  const socket = flag('socket') ?? process.env['AOT_APPROVAL_SOCKET'] ?? join(instance, 'run', 'approval.sock');
  const [cmd, kindArg, id] = positional;
  const kind = kindArg === 'policy' ? 'policy_version' : kindArg;
  const needKind = () => {
    if (!(KINDS as readonly (string | undefined)[]).includes(kind)) fail(`kind must be one of ${KINDS.join('|')}`);
    if (!id) fail('an id is required');
  };
  const comment = flag('comment');

  let request: Record<string, unknown>;
  switch (cmd) {
    case 'totp-enroll': {
      const store = new TotpSecretStore(flag('totp-dir') ?? join(instance, 'totp'));
      const secret = store.enroll(actor);
      // 등록 URI 는 비밀을 담는다. 화면에 한 번만 보여 주고 다른 곳에 남기지 않는다.
      process.stdout.write(`${otpauthUri(secret, actor)}\n`);
      return;
    }
    case 'whoami':
    case 'list':
      request = { cmd, actor };
      break;
    case 'show':
      needKind();
      request = { cmd, actor, kind, id };
      break;
    case 'approve':
      if (kind === 'policy_version') {
        const file = flag('file') ?? fail('approve policy needs --file <policy.yaml>');
        request = { cmd, actor, kind, policy_text: readFileSync(file, 'utf8'), ...(comment ? { comment } : {}) };
      } else {
        needKind();
        request = { cmd, actor, kind, id, hash: flag('hash') ?? fail('approve needs --hash (from `show`)'), ...(comment ? { comment } : {}) };
      }
      break;
    case 'release':
      needKind();
      request = { cmd, actor, kind, id, ...(flags.get('totp-stdin') === true ? { totp: await readStdinLine() } : {}) };
      break;
    case 'cancel':
    case 'reject':
      needKind();
      request = { cmd, actor, kind, id, ...(comment ? { comment } : {}) };
      break;
    default:
      fail('usage: approve.ts [--socket PATH] [--actor ID] whoami|list|show|approve|release|cancel|reject|totp-enroll ...');
  }
  const response = await sendApprovalRequest(socket, request) as { ok: boolean };
  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exitCode = response.ok ? 0 : 1;
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
