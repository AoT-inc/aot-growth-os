// 화면이 결정을 보낼 때 쓰는 상태: 엔진 어댑터(소켓), 속도 제한, 결과 보관(PRG). 엔진과 말하는 곳은 여기 `DecisionClient` 한 군데뿐이다.
// 화면 프로세스는 DB 에 쓰지 않는다. 검증·기록은 데몬의 승인 엔진이 하고, 이 어댑터는 승인 CLI 와 같은 소켓으로 요청 한 줄을 보낸다.
import { randomBytes } from 'node:crypto';

import { ApprovalChannelError, sendApprovalRequest } from '@aot/policy';

/** 엔진 응답. 거부면 `error`(영어 원문)와, 트랙 B 이후 `code`(기계가 읽는 사유)가 있다 */
export interface EngineResponse {
  ok: boolean;
  error?: string;
  code?: string;
  [field: string]: unknown;
}

export type SendOutcome =
  | { kind: 'response'; response: EngineResponse }
  /** 소켓에 닿지 못했다: 요청은 엔진에 가지 않았다 */
  | { kind: 'unreachable' }
  /** 보낸 뒤 응답을 못 받았다(시간 초과·끊김): 엔진이 처리했는지 모른다 */
  | { kind: 'unknown' };

export interface DecisionClient {
  send(request: Record<string, unknown>): Promise<SendOutcome>;
}

const NOT_DELIVERED = new Set(['ENOENT', 'ECONNREFUSED', 'EACCES', 'ENOTSOCK', 'ENOTDIR', 'EPERM']);

/** 승인 CLI 와 같은 Unix 소켓(0700 폴더, 0600 파일)으로 보낸다. 요청 본문(OTP 포함)은 어디에도 기록하지 않는다 */
export function createSocketClient(socketPath: string, timeoutMs = 10_000): DecisionClient {
  return {
    async send(request) {
      try {
        const response = await sendApprovalRequest(socketPath, request, timeoutMs);
        if (typeof response !== 'object' || response === null || typeof (response as { ok?: unknown }).ok !== 'boolean') return { kind: 'unknown' };
        return { kind: 'response', response: response as EngineResponse };
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string' && NOT_DELIVERED.has(code)) return { kind: 'unreachable' };
        if (error instanceof ApprovalChannelError || code === 'ECONNRESET' || code === 'EPIPE') return { kind: 'unknown' };
        return { kind: 'unknown' };
      }
    },
  };
}

/** 시작할 때 소켓으로 `whoami` 를 보내 이 행위자가 사람인지 확인한다. 실패하면 읽기 전용으로 띄우고 까닭을 돌려준다 */
export async function connectWriter(actor: string | null, client: DecisionClient): Promise<{ writer?: { actor: string; client: DecisionClient }; notice?: string }> {
  if (actor === null) return { notice: '결정하려면 화면을 시작할 때 사람 행위자(--actor)를 주세요.' };
  const outcome = await client.send({ cmd: 'whoami', actor });
  if (outcome.kind === 'unreachable') return { notice: '승인 엔진(데몬)에 닿지 못해 결정 버튼을 껐습니다. 데몬을 켠 뒤 화면을 다시 시작하세요.' };
  if (outcome.kind === 'unknown') return { notice: '승인 엔진이 응답하지 않아 결정 버튼을 껐습니다.' };
  if (!outcome.response.ok || outcome.response['kind'] !== 'human') return { notice: '시작할 때 준 행위자가 사람이 아니거나 엔진이 받아들이지 않아 결정 버튼을 껐습니다.' };
  return { writer: { actor, client } };
}

/** 창 안에서 `limit` 번까지 */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  #hits: number[] = [];

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  /** 지금 한 번 써도 되나. 되면 세어 둔다 */
  take(nowMs: number): boolean {
    this.#hits = this.#hits.filter((at) => nowMs - at < this.#windowMs);
    if (this.#hits.length >= this.#limit) return false;
    this.#hits.push(nowMs);
    return true;
  }
}

export type StepOutcome = 'done' | 'refused' | 'unreachable' | 'unknown' | 'skipped';

export interface StepResult {
  label: string;
  outcome: StepOutcome;
  /** 엔진 거부 사유 코드 (없으면 undefined) */
  code?: string | undefined;
  /** 엔진 영어 원문 (자세히에만 보인다) */
  error?: string | undefined;
}

export interface DecisionResult {
  id: string;
  at: number;
  /** 누른 버튼 이름 */
  button: string;
  /** 성공 문구 */
  done: string;
  /** 다시 보러 갈 상세 화면 */
  href: string;
  steps: StepResult[];
}

export const RESULT_TTL_MS = 10 * 60_000;
const RESULT_MAX = 200;

/** 결과는 메모리에 10분만 둔다. 비밀·OTP 는 담지 않는다 */
export class ResultStore {
  readonly #items = new Map<string, DecisionResult>();

  put(result: Omit<DecisionResult, 'id'>, nowMs: number): string {
    for (const [id, item] of this.#items) if (nowMs - item.at > RESULT_TTL_MS) this.#items.delete(id);
    while (this.#items.size >= RESULT_MAX) this.#items.delete(this.#items.keys().next().value as string);
    const id = randomBytes(16).toString('hex');
    this.#items.set(id, { ...result, id });
    return id;
  }

  get(id: string, nowMs: number): DecisionResult | undefined {
    const item = this.#items.get(id);
    if (item === undefined) return undefined;
    if (nowMs - item.at > RESULT_TTL_MS) {
      this.#items.delete(id);
      return undefined;
    }
    return item;
  }
}

export interface WriteState {
  /** 결정하는 사람 행위자(시작 인자 `--actor`, 시작 때 `whoami` 로 사람임을 확인했다) */
  actor: string;
  client: DecisionClient;
  /** 화면 전체 결정 요청: 분당 20건 */
  decisions: RateLimiter;
  /** OTP 가 든 요청: 5분에 5번 */
  otp: RateLimiter;
  results: ResultStore;
}

export function createWriteState(actor: string, client: DecisionClient): WriteState {
  return { actor, client, decisions: new RateLimiter(20, 60_000), otp: new RateLimiter(5, 5 * 60_000), results: new ResultStore() };
}
