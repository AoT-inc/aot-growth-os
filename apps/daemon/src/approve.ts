// 사람용 승인 CLI (trust-boundaries §3.1). 데몬의 승인 엔진과 Unix 도메인 소켓으로만 통신한다. DB 를 직접 열지 않는다.
//   node apps/daemon/src/approve.ts [--socket PATH] [--actor ID] <명령>
//     whoami | list                  (list: 승인 대기 업무·게시·정책 제안, 승인을 기다리는 실험 전략 제안, 추천 없이 끝나 검토할 비교 기록, 진행 중인 실험)
//     show    <task|publication|policy_version|strategy> <id>      (strategy = strategy_version)
//     approve <task|publication|strategy> <id> --hash <show 가 보여 준 해시> [--comment 글]
//             (strategy: 사람 1인 승인으로 바로 proposed → experiment. 루틴 활성화는 데몬의 주간 사이클이 한다)
//     approve policy --file <정책.yaml> [--comment 글]          (배포 승인. 위험 변경이면 cooldown 뒤 release)
//     release <task|publication|policy_version> <id> [--totp-stdin]   (TOTP 코드는 표준 입력 한 줄로 받는다)
//     cancel  <task|publication|policy_version|strategy> <id> [--comment 글]   (cooldown 중 취소. strategy 는 활성화 전에만)
//     reject  <task|publication|policy_version|strategy> <id> [--comment 글]
//     totp-enroll [--totp-dir DIR]   (이 기기에서 실행. 비밀을 instance/totp/<actor> 에 0600 으로 만들고 등록 URI 를 한 번 보여 준다)
//     promote strategy <id> --comment 사유     (A6-U16. 결과가 pass 로 기록된 실험을 experiment → active 로 올린다. 사람만, 이전 active 는 retired. 사유 필수)
//     reject  strategy <id> --comment 사유     (proposed 는 승인 엔진이, experiment 는 결과 채널이 처리한다: experiment → rejected. experiment 는 사유 필수)
//     reviews                       (A6-U16. 실험 결과 검토 현황: 결과 대기, 승격 대기(pass), 사람 검토 필요(inconclusive 등))
//     measure <신호 id> <값> --observations N --quality good|poor --attach <파일> [--attach <파일> ...] [--week YYYY-Www] [--minutes M]
//             (A6-U13. 첨부 파일은 이 CLI 가 읽어 sha256 과 로컬 참조 `file:<절대 경로>` 만 보낸다. 주를 생략하면 데몬 시계 기준 지난주)
//     measurements                   (측정 값을 기다리는 업무와 사유, 정의된 신호)
// 기본값: --socket = $AOT_APPROVAL_SOCKET 또는 $AOT_INSTANCE_DIR/run/approval.sock, --actor = $AOT_ACTOR
// TOTP 코드는 명령줄 인자로 받지 않는다(프로세스 목록에 보이므로).
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { otpauthUri, sendApprovalRequest, TotpSecretStore } from '@aot/policy';

const KINDS = ['task', 'publication', 'policy_version', 'strategy_version'] as const;
const KIND_ALIASES: Readonly<Record<string, string>> = { policy: 'policy_version', strategy: 'strategy_version' };

function fail(message: string): never {
  console.error(`aot-approve: ${message}`);
  process.exit(2);
}

function parseArgs(argv: string[]): { flags: Map<string, string | true>; positional: string[]; attachments: string[] } {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  const attachments: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === 'totp-stdin') flags.set(name, true);
    else if (i + 1 >= argv.length) fail(`--${name} needs a value`);
    else if (name === 'attach') attachments.push(argv[(i += 1)]!); // 여러 번 줄 수 있다
    else flags.set(name, argv[(i += 1)]!);
  }
  return { flags, positional, attachments };
}

/** 첨부 파일의 sha256 과 로컬 참조. 내용은 보내지 않는다 */
async function describeAttachment(path: string): Promise<{ ref: string; sha256: string }> {
  const absolute = realpathSync(path);
  if (!statSync(absolute).isFile()) fail(`--attach ${path}: not a regular file`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absolute)) hash.update(chunk as Buffer);
  return { ref: `file:${absolute}`, sha256: hash.digest('hex') };
}

/** 사람이 친 숫자만 받는다 (`0x10`, `1e3`, 빈 문자열 같은 모양은 거부) */
function parseNumber(text: string | undefined, what: string, integer: boolean): number {
  const pattern = integer ? /^\d+$/ : /^\d+(\.\d+)?$/;
  if (text === undefined || !pattern.test(text)) fail(`${what} must be ${integer ? 'a whole number' : 'a number'} >= 0`);
  return Number(text);
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
  const { flags, positional, attachments } = parseArgs(process.argv.slice(2));
  const instance = process.env['AOT_INSTANCE_DIR'] ?? 'instance';
  const flag = (name: string): string | undefined => {
    const value = flags.get(name);
    return typeof value === 'string' ? value : undefined;
  };
  const actor = flag('actor') ?? process.env['AOT_ACTOR'] ?? fail('--actor (or AOT_ACTOR) is required');
  const socket = flag('socket') ?? process.env['AOT_APPROVAL_SOCKET'] ?? join(instance, 'run', 'approval.sock');
  const [cmd, kindArg, id] = positional;
  const kind = kindArg === undefined ? undefined : KIND_ALIASES[kindArg] ?? kindArg;
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
    case 'measurements':
    case 'reviews':
      request = { cmd, actor };
      break;
    case 'measure': {
      const [, signal, valueText] = positional;
      if (!signal) fail('measure needs a signal id and a value');
      const quality = flag('quality') ?? fail('measure needs --quality good|poor');
      const week = flag('week');
      const minutes = flag('minutes');
      request = {
        cmd, actor, signal,
        value: parseNumber(valueText, 'the value', false),
        observations: parseNumber(flag('observations'), '--observations', true),
        quality,
        attachments: await Promise.all(attachments.map(describeAttachment)),
        ...(week === undefined ? {} : { week }),
        ...(minutes === undefined ? {} : { minutes: parseNumber(minutes, '--minutes', false) }),
      };
      break;
    }
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
    case 'promote':
      needKind();
      request = { cmd, actor, kind, id, comment: comment ?? fail('promote needs --comment <reason>') };
      break;
    default:
      fail('usage: approve.ts [--socket PATH] [--actor ID] whoami|list|show|approve|release|cancel|reject|promote|reviews|totp-enroll|measure|measurements ...');
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
