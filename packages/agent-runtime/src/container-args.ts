// 컨테이너 인자 생성기 (단계 A5 U3, 스파이크 Q26 §3·§4·§5·"남은 위험 1"). `docker run` 인자는 이 파일의 고정 템플릿으로만 만든다.
//  - 입력은 데몬 설정에서 온 값뿐이다: 이미지 ID(`sha256:…`, 태그 거부), 컨테이너 이름, run 라벨, 인스턴스 라벨, 자원 상한, 비루트 사용자, 선택적 에이전트 인자.
//    업무 명세(task_spec)의 값은 이 함수에 들어오지 않는다. 업무 입력은 stdin 의 `start` 프레임으로만 간다(frames.ts).
//  - 항상 들어가는 강화 플래그: --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges, 크기 제한 tmpfs 작업 디렉터리,
//    메모리·CPU·pids 제한, --ipc none, --log-driver none, --user <비루트>, --label aot.run=<id>, --label aot.instance=<인스턴스 ID>, --pull never.
//    인스턴스 라벨은 한 Docker 호스트에서 데몬이 둘 이상 돌 때 고아 정리가 다른 데몬의 컨테이너를 지우지 않게 한다(정리는 `aot.run` AND `aot.instance` 로만 고른다).
//  - 바인드 마운트·볼륨·환경 변수는 템플릿에 없다. 설정이나 에이전트 인자에 위험 플래그(-v/--mount/--privileged/--cap-add/--device/--network 변경/
//    --pid/--userns/--security-opt/--env/--user/--entrypoint 등)가 섞이면 던진다. "마운트 0개"가 격리의 조건이다(Docker Desktop 은 호스트 파일 권한을 적용하지 않는다).
//  - 에이전트 인자는 이미지 뒤에 놓인다(docker 는 이미지 뒤의 인자를 해석하지 않는다). 위험 플래그 거부는 그 위치 보장에 더한 이중 방어다.
// 던지는 오류는 `ContainerArgsError`(code 로 구분)다. 설정 오류는 데몬 개발 오류라 기본 거부(실행하지 않음)다.

export const CONTAINER_LABEL_KEY = 'aot.run';
/** 컨테이너를 띄운 데몬 인스턴스의 라벨 키. 값은 데몬 설정에서 도출한 안전한 문자열이다 */
export const INSTANCE_LABEL_KEY = 'aot.instance';
/** 이미지 사용자(distroless nonroot = 65532)와 같은 값. 데몬 사용자의 UID 와 다르게 둔다 (스파이크 §6) */
export const DEFAULT_CONTAINER_USER: Readonly<{ uid: number; gid: number }> = { uid: 65532, gid: 65532 };
export const CONTAINER_WORKDIR = '/work';

export type ContainerArgsErrorCode =
  | 'forbidden_flag' | 'forbidden_config_field' | 'image_not_id' | 'invalid_name' | 'invalid_label' | 'invalid_limit' | 'invalid_user' | 'invalid_agent_arg'
  | 'invalid_instance';

export class ContainerArgsError extends Error {
  readonly code: ContainerArgsErrorCode;
  constructor(code: ContainerArgsErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ContainerArgsError';
    this.code = code;
  }
}

export interface ContainerLimits {
  /** 메모리와 swap 의 상한(MiB). swap 은 메모리와 같은 값으로 둔다(swap 없음) */
  memoryMiB: number;
  cpus: number;
  pidsLimit: number;
  /** /work tmpfs 크기(MiB) */
  tmpfsMiB: number;
}

export interface ContainerConfig {
  /** 이미지 ID `sha256:<64 hex>`. 태그·이름·digest 참조는 거부한다 */
  image: string;
  /** 컨테이너 이름. 영숫자와 `_.-` 만(첫 글자는 영숫자), 100자 이하 */
  name: string;
  /** `aot.run` 라벨 값. 이름과 같은 문자 규칙 */
  runId: string;
  /** `aot.instance` 라벨 값(데몬 인스턴스 ID). 영숫자와 `_.-` 만(첫 글자는 영숫자), 63자 이하. 필수다: 없으면 고아 정리가 인스턴스를 구분하지 못한다 */
  instance: string;
  limits: ContainerLimits;
  /** 비루트 사용자. 생략하면 DEFAULT_CONTAINER_USER. uid·gid 가 0 이면 거부 */
  user?: { uid: number; gid: number };
  /** 이미지 뒤에 붙는 에이전트 인자(데몬 설정). 위험 플래그·제어 문자는 거부 */
  agentArgs?: readonly string[];
  /** 고정값만 허용한다(생략해도 같다) */
  network?: 'none';
  /** 고정값 `['no-new-privileges']` 만 허용한다(생략해도 같다) */
  securityOpt?: readonly ['no-new-privileges'];
}

const CONFIG_KEYS: readonly string[] = ['image', 'name', 'runId', 'instance', 'limits', 'user', 'agentArgs', 'network', 'securityOpt'];
const LIMIT_KEYS: readonly string[] = ['memoryMiB', 'cpus', 'pidsLimit', 'tmpfsMiB'];
const USER_KEYS: readonly string[] = ['uid', 'gid'];

/** 에이전트 인자·설정 이름으로 쓰이면 거부하는 docker run 플래그 이름 (대시 없이, 소문자) */
const FORBIDDEN_FLAGS: ReadonlySet<string> = new Set([
  'v', 'volume', 'mount', 'volumes-from', 'privileged', 'cap-add', 'cap-drop', 'device', 'device-cgroup-rule', 'device-read-bps', 'device-write-bps',
  'network', 'net', 'network-alias', 'pid', 'userns', 'uts', 'ipc', 'cgroupns', 'cgroup-parent', 'security-opt', 'env', 'e', 'env-file',
  'user', 'u', 'group-add', 'entrypoint', 'add-host', 'dns', 'dns-option', 'dns-search', 'hostname', 'h', 'domainname', 'mac-address', 'ip', 'ip6',
  'link', 'link-local-ip', 'publish', 'p', 'publish-all', 'expose', 'runtime', 'sysctl', 'ulimit', 'tmpfs', 'read-only', 'workdir', 'w',
  'name', 'label', 'l', 'label-file', 'restart', 'rm', 'init', 'gpus', 'shm-size', 'storage-opt', 'platform', 'pull', 'log-driver', 'log-opt',
  'memory', 'm', 'memory-swap', 'memory-reservation', 'cpus', 'cpu-shares', 'c', 'cpuset-cpus', 'cpuset-mems', 'pids-limit', 'oom-kill-disable',
  'oom-score-adj', 'attach', 'a', 'detach', 'd', 'detach-keys', 'cidfile', 'isolation', 'stop-signal', 'stop-timeout', 'volume-driver', 'annotation',
  'health-cmd', 'no-healthcheck', 'use-api-socket',
]);
/** 짧은 플래그 묶음(`-v/x:/y`, `-ti`)에서 위험한 글자 */
const FORBIDDEN_SHORT: ReadonlySet<string> = new Set(['v', 'e', 'u', 'p', 'P', 'l', 'w', 'h', 'm', 'c', 'a', 'd']);

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const AGENT_ARG_PATTERN = /^[\x21-\x7e]{1,512}$/; // 공백·제어 문자·비ASCII 없음
const MAX_AGENT_ARGS = 32;

const kebab = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** 인자 하나가 위험 docker 플래그 모양이면 그 이름을, 아니면 null */
export function forbiddenFlagIn(arg: string): string | null {
  if (!arg.startsWith('-')) return null;
  const body = arg.replace(/^-{1,2}/, '');
  const name = (body.split('=')[0] ?? '').toLowerCase();
  if (FORBIDDEN_FLAGS.has(name)) return name;
  if (!arg.startsWith('--') && body.length > 0) {
    // 짧은 플래그 묶음: 값이 붙어 있어도(`-v/x:/y`, `-eKEY=1`) 첫 글자가 위험하면 거부, 묶음 안의 위험 글자도 거부
    const cluster = body.split('=')[0] ?? '';
    for (const letter of cluster) if (FORBIDDEN_SHORT.has(letter)) return letter;
  }
  return null;
}

function checkName(value: unknown, what: string, code: ContainerArgsErrorCode): string {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    throw new ContainerArgsError(code, `${what} must start with a letter or digit and contain only letters, digits, '_', '.', '-' (max 100 chars)`);
  }
  return value;
}

/** `aot.instance` 라벨 값으로 쓸 수 있는 문자열인가 (docker 필터에도 그대로 들어가므로 같은 규칙을 정리 쪽도 쓴다) */
export function isValidInstanceId(value: unknown): value is string {
  return typeof value === 'string' && INSTANCE_PATTERN.test(value);
}

function checkInt(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ContainerArgsError('invalid_limit', `${what} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function checkId(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new ContainerArgsError('invalid_user', `${what} must be an integer >= 1 (root is never allowed)`);
  }
  return value;
}

function rejectUnknownKeys(object: object, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(object)) {
    if (allowed.includes(key)) continue;
    const flag = FORBIDDEN_FLAGS.has(kebab(key)) ? ` (docker flag --${kebab(key)} is never allowed)` : '';
    throw new ContainerArgsError('forbidden_config_field', `unknown ${where} field '${key}'${flag}`);
  }
}

/**
 * 고정 템플릿으로 `docker` 실행 파일에 넘길 인자 배열(`run` 으로 시작)을 만든다. 셸을 거치지 않으므로 인용이 필요 없다.
 * 설정이 규칙을 어기면 `ContainerArgsError`.
 */
export function buildContainerArgs(config: ContainerConfig): string[] {
  if (typeof config !== 'object' || config === null) throw new ContainerArgsError('forbidden_config_field', 'config must be an object');
  rejectUnknownKeys(config, CONFIG_KEYS, 'config');

  if (typeof config.image !== 'string' || !IMAGE_ID_PATTERN.test(config.image)) {
    throw new ContainerArgsError('image_not_id', "image must be an image ID of the form 'sha256:<64 hex>' (tags and names are never used)");
  }
  const name = checkName(config.name, 'container name', 'invalid_name');
  const runId = checkName(config.runId, 'run label value', 'invalid_label');
  if (!isValidInstanceId(config.instance)) {
    throw new ContainerArgsError('invalid_instance', "instance must start with a letter or digit and contain only letters, digits, '_', '.', '-' (max 63 chars)");
  }
  const instance = config.instance;

  const limits = config.limits;
  if (typeof limits !== 'object' || limits === null) throw new ContainerArgsError('invalid_limit', 'limits are required');
  rejectUnknownKeys(limits, LIMIT_KEYS, 'limits');
  const memoryMiB = checkInt(limits.memoryMiB, 'memoryMiB', 16, 16384);
  const pidsLimit = checkInt(limits.pidsLimit, 'pidsLimit', 8, 4096);
  const tmpfsMiB = checkInt(limits.tmpfsMiB, 'tmpfsMiB', 1, 1024);
  const cpus = limits.cpus;
  if (typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus < 0.1 || cpus > 16 || Math.round(cpus * 100) / 100 !== cpus) {
    throw new ContainerArgsError('invalid_limit', 'cpus must be a number between 0.1 and 16 with at most two decimals');
  }

  const user = config.user ?? DEFAULT_CONTAINER_USER;
  if (typeof user !== 'object' || user === null) throw new ContainerArgsError('invalid_user', 'user must be {uid, gid}');
  rejectUnknownKeys(user, USER_KEYS, 'user');
  const uid = checkId(user.uid, 'user.uid');
  const gid = checkId(user.gid, 'user.gid');

  if (config.network !== undefined && config.network !== 'none') {
    throw new ContainerArgsError('forbidden_flag', "--network may only be 'none'");
  }
  if (config.securityOpt !== undefined && !(Array.isArray(config.securityOpt) && config.securityOpt.length === 1 && config.securityOpt[0] === 'no-new-privileges')) {
    throw new ContainerArgsError('forbidden_flag', "--security-opt may only be ['no-new-privileges']");
  }

  const agentArgs = config.agentArgs ?? [];
  if (!Array.isArray(agentArgs) || agentArgs.length > MAX_AGENT_ARGS) {
    throw new ContainerArgsError('invalid_agent_arg', `agentArgs must be an array of at most ${MAX_AGENT_ARGS} strings`);
  }
  for (const arg of agentArgs as readonly unknown[]) {
    if (typeof arg !== 'string' || !AGENT_ARG_PATTERN.test(arg)) {
      throw new ContainerArgsError('invalid_agent_arg', 'an agent argument must be 1-512 printable ASCII characters without spaces');
    }
    const flag = forbiddenFlagIn(arg);
    if (flag !== null) throw new ContainerArgsError('forbidden_flag', `agent argument '${arg.slice(0, 40)}' looks like the docker flag '${flag}'`);
  }

  return [
    'run', '--rm', '-i', '--pull', 'never',
    '--name', name,
    '--label', `${CONTAINER_LABEL_KEY}=${runId}`,
    '--label', `${INSTANCE_LABEL_KEY}=${instance}`,
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--tmpfs', `${CONTAINER_WORKDIR}:rw,noexec,nosuid,nodev,size=${tmpfsMiB}m,uid=${uid},gid=${gid},mode=0700`,
    '--workdir', CONTAINER_WORKDIR,
    '--memory', `${memoryMiB}m`, '--memory-swap', `${memoryMiB}m`,
    '--cpus', String(cpus),
    '--pids-limit', String(pidsLimit),
    '--ipc', 'none',
    '--log-driver', 'none',
    '--user', `${uid}:${gid}`,
    config.image,
    ...agentArgs,
  ];
}
