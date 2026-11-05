// 화면에서 결정 보내기 (설계 §2.3·§2.4): POST /decide 의 본체와 결과 화면(PRG).
// 이 파일은 DB 에 쓰지 않는다. 폼이 가진 것은 (결정 키, 버튼 이름, 본 내용의 지문, 발급 시각, nonce) 뿐이고, 무엇을 보낼지는 서버가 DB 에서 같은 결정을 다시 만들어 정한다.
// 지문이 폼을 만들 때와 다르면(그 사이 내용이 바뀜) 보내지 않는다. 보낼 때는 승인 CLI 와 같은 소켓으로 `expected_hash`·`via:'web'` 를 싣는다(엔진 쪽은 트랙 B).
// 엔진 응답의 `code` 로만 실패 문구를 정한다. 코드가 없거나 모르는 코드면 "처리하지 못했습니다" 한 줄(영어 원문은 자세히에만 보인다).
import { fingerprint, REASON_MAX_CHARS, type Button, type Step } from './actions.ts';
import type { ReviewContext } from './context.ts';
import { resolveDecision } from './decisions.ts';
import { details, h, kv, link, type Raw } from './html.ts';
import type { EngineResponse, StepResult } from './write-state.ts';

export interface DecideReply {
  status: number;
  /** 303 이면 이동할 곳 */
  location?: string;
  /** 303 이 아닐 때 보일 짧은 글 (평문) */
  message?: string;
}

const text = (status: number, message: string): DecideReply => ({ status, message });

/** 엔진이 `expected_hash` 를 대조하는 명령 (트랙 B 계약 §5). approve 는 hash 로 이미 대조한다 */
const EXPECTS_HASH = new Set(['reject', 'cancel', 'request_changes', 'release', 'promote']);

const FIELD_MAX = { key: 300, verb: 40, hash: 64, issued: 16, nonce: 64, reason: 4_000, totp: 32 } as const;

function field(form: URLSearchParams, name: keyof typeof FIELD_MAX): string | null {
  const values = form.getAll(name);
  if (values.length > 1) return null;
  const value = values[0] ?? '';
  return value.length > FIELD_MAX[name] ? null : value;
}

// ----- 실패 문구 (설계 §2.4) -----
type Next = 'fresh' | 'home' | 'effects' | 'again' | 'status';
export interface Failure {
  headline: string;
  /** 묶음 요약에 붙는 짧은 사유 */
  short: string;
  next: Next[];
}

const FAILURES: Readonly<Record<string, Failure>> = {
  hash_mismatch: { headline: '결정이 반영되지 않았습니다. 그 사이 내용이 바뀌었습니다.', short: '내용이 바뀜', next: ['fresh'] },
  wrong_state: { headline: '이미 다른 결정이 났습니다.', short: '이미 처리됨', next: ['home'] },
  send_started: { headline: '이미 보내기 시작해 거절·다시 쓰게를 할 수 없습니다.', short: '이미 보내기 시작함', next: ['effects'] },
  masked: { headline: '가려진 값이 있어 승인할 수 없습니다. 다시 쓰게 해 주세요.', short: '가려진 값이 있음', next: ['fresh'] },
  expired: { headline: '초안 기한이 지나 승인할 수 없습니다. 다시 쓰게 해 주세요.', short: '기한이 지남', next: ['fresh'] },
  policy_denied: { headline: '지금 정책이 허용하지 않아 승인할 수 없습니다.', short: '정책이 거부함', next: ['fresh'] },
  self_approval: { headline: '요청한 사람이 직접 승인할 수 없습니다.', short: '직접 승인할 수 없음', next: ['home'] },
  cooldown: { headline: '아직 대기 시간이 끝나지 않았습니다.', short: '대기 시간 중', next: ['fresh'] },
  reauth_required: { headline: 'OTP 코드가 필요합니다.', short: 'OTP 필요', next: ['again'] },
  reauth_failed: { headline: 'OTP 코드가 맞지 않습니다.', short: 'OTP 코드 틀림', next: ['again'] },
  reauth_locked: { headline: '잠시 뒤 다시 하세요(5분).', short: 'OTP 입력 잠김', next: ['again'] },
  not_human: { headline: '이 결정은 사람만 할 수 있습니다. 화면을 시작할 때 준 행위자가 사람인지 확인하세요.', short: '사람만 결정할 수 있음', next: ['home'] },
  bad_request: { headline: '요청이 맞지 않아 처리하지 못했습니다.', short: '요청이 맞지 않음', next: ['fresh'] },
  stale_form: { headline: '이 화면이 오래돼서 결정을 보내지 않았습니다.', short: '화면이 오래됨', next: ['fresh'] },
  gone: { headline: '이미 다른 결정이 났거나 더 이상 결정할 일이 아닙니다.', short: '이미 처리됨', next: ['home'] },
};
const OTHER: Failure = { headline: '처리하지 못했습니다.', short: '처리하지 못함', next: ['fresh'] };
const UNREACHABLE: Failure = { headline: '데몬이 꺼져 있어 보내지 못했습니다. 아무것도 바뀌지 않았습니다.', short: '데몬이 꺼져 있음', next: ['again'] };
const UNKNOWN: Failure = { headline: '결과를 확인하지 못했습니다.', short: '결과를 확인하지 못함', next: ['status'] };

export const failureOf = (step: StepResult): Failure => (step.outcome === 'unreachable' ? UNREACHABLE : step.outcome === 'unknown' ? UNKNOWN : FAILURES[step.code ?? ''] ?? OTHER);

// ----- POST 처리 -----
const STOPPING = new Set(['reauth_failed', 'reauth_locked']);

function requestOf(write: NonNullable<ReviewContext['write']>, button: Button, step: Step, reason: string, totp: string): Record<string, unknown> {
  const request: Record<string, unknown> = { ...step.request, actor: write.actor, via: 'web' };
  if (step.hash !== null && EXPECTS_HASH.has(String(step.request['cmd']))) request['expected_hash'] = step.hash;
  if (reason !== '') request[step.textField ?? 'comment'] = reason;
  if (button.otp === true) request['totp'] = totp;
  return request;
}

async function sendSteps(ctx: ReviewContext, button: Button, reason: string, totp: string): Promise<StepResult[]> {
  const write = ctx.write!;
  const results: StepResult[] = [];
  let stopped = false;
  for (const step of button.steps) {
    if (stopped) {
      results.push({ label: step.label, outcome: 'skipped' });
      continue;
    }
    const outcome = await write.client.send(requestOf(write, button, step, reason, totp));
    if (outcome.kind === 'unreachable' || outcome.kind === 'unknown') {
      results.push({ label: step.label, outcome: outcome.kind });
      stopped = true;
      continue;
    }
    const response: EngineResponse = outcome.response;
    if (response.ok) {
      results.push({ label: step.label, outcome: 'done' });
      continue;
    }
    const code = typeof response.code === 'string' ? response.code : undefined;
    results.push({ label: step.label, outcome: 'refused', code, error: typeof response.error === 'string' ? response.error : undefined });
    if (code !== undefined && STOPPING.has(code)) stopped = true; // 틀린 OTP 를 건마다 되풀이해 보내지 않는다
  }
  return results;
}

/** 폼 하나를 처리한다. 이 함수에 오는 요청은 이미 Host·쿠키·Origin·Sec-Fetch-Site·Content-Type·크기 확인을 통과했다 */
export async function decide(ctx: ReviewContext, form: URLSearchParams): Promise<DecideReply> {
  const write = ctx.write;
  if (write === null) return text(405, 'decisions are not enabled');
  const now = ctx.clock.nowMs();
  if (!write.decisions.take(now)) return text(429, '결정 요청이 너무 많습니다. 잠시 뒤 다시 하세요.');

  const key = field(form, 'key');
  const verb = field(form, 'verb');
  const hash = field(form, 'hash');
  const issued = field(form, 'issued');
  const nonce = field(form, 'nonce');
  const rawReason = field(form, 'reason');
  const rawTotp = field(form, 'totp');
  if (key === null || verb === null || hash === null || issued === null || nonce === null || rawReason === null || rawTotp === null || key === '' || verb === '') return text(400, 'bad request');
  const check = ctx.forms.check({ verb, key, hash, issued, nonce }, now);
  if (check === 'bad') return text(403, 'invalid form token');
  if (check === 'used') {
    const earlier = ctx.forms.resultOf(nonce);
    return earlier === undefined ? text(409, '이미 보낸 요청입니다. 잠시 뒤 결과를 확인하세요.') : { status: 303, location: `/result/${earlier}` };
  }
  const store = (steps: StepResult[], buttonLabel: string, done: string, href: string): DecideReply => {
    const id = write.results.put({ at: now, button: buttonLabel, done, href, steps }, now);
    ctx.forms.consume(nonce, now, id);
    return { status: 303, location: `/result/${id}` };
  };
  if (check === 'expired') return store([{ label: '', outcome: 'refused', code: 'stale_form' }], '', '', '/');

  // 같은 결정을 DB 에서 다시 만든다 (폼 값은 어떤 요청을 보낼지 정하지 않는다)
  const decision = resolveDecision(ctx, key);
  const button = decision?.actions.buttons.find((b) => b.verb === verb);
  if (decision === undefined || button === undefined) return store([{ label: '', outcome: 'refused', code: 'gone' }], '', '', '/');

  const reason = rawReason.trim();
  const totp = rawTotp.trim();
  if (reason.length > REASON_MAX_CHARS || (button.reason === 'required' && reason === '') || (button.reason === 'none' && reason !== '')) return text(400, 'bad request: reason');
  if (button.otp === true ? !/^\d{6}$/.test(totp) : totp !== '') return text(400, 'bad request: otp');
  if (button.otp === true && !write.otp.take(now)) return text(429, 'OTP 입력이 너무 많습니다. 5분 뒤 다시 하세요.');

  // 폼을 만든 뒤 내용이 바뀌었으면 보내지 않는다 (낡은 화면에 대한 결정 방지)
  if (fingerprint(button) !== hash) return store([{ label: button.steps[0]?.label ?? '', outcome: 'refused', code: 'hash_mismatch' }], button.label, button.done, decision.href);
  ctx.forms.consume(nonce, now);
  const steps = await sendSteps(ctx, button, reason, totp);
  const id = write.results.put({ at: now, button: button.label, done: button.done, href: decision.href, steps }, now);
  ctx.forms.consume(nonce, now, id);
  return { status: 303, location: `/result/${id}` };
}

// ----- 결과 화면 (결론 한 줄 → 다음에 할 일 → 접힌 자세히) -----
export interface ResultPage {
  title: string;
  body: Raw;
}

const NEXT_LABEL: Readonly<Record<Next, string>> = { fresh: '새 내용 보기', home: '결정할 일로 가기', effects: '전송 여부 카드 보기', again: '다시 하기', status: '상태 다시 보기' };

export function resultPage(ctx: ReviewContext, id: string): ResultPage | null {
  const result = ctx.write?.results.get(id, ctx.clock.nowMs());
  if (result === undefined) return null;
  const steps = result.steps;
  const failed = steps.filter((s) => s.outcome !== 'done');
  const doneCount = steps.length - failed.length;
  const first = failed[0];
  const hrefOf = (next: Next): string => (next === 'home' ? '/' : next === 'effects' ? '/effects' : result.href);
  let title: string;
  let nexts: Next[];
  if (first === undefined) {
    title = result.done;
    nexts = ['home'];
  } else if (steps.length > 1 && doneCount > 0) {
    const reasons = [...new Set(failed.map((s) => failureOf(s).short))].join(', ');
    title = `${steps.length}건 중 ${doneCount}건 반영, ${failed.length}건 실패: ${reasons}`;
    nexts = ['fresh', 'home'];
  } else {
    const failure = failureOf(first);
    title = failure.headline;
    nexts = failure.next;
  }
  const body = h`${first === undefined || failed.length === 0 ? '' : h`${steps.length > 1 ? h`<ul class="facts">${steps.map((s) => h`<li><b>${s.outcome === 'done' ? '반영됨' : '실패'}</b> ${s.label}${s.outcome === 'done' ? '' : ` — ${s.outcome === 'skipped' ? '보내지 않음' : failureOf(s).short}`}</li>`)}</ul>` : ''}`}
    <p>${nexts.map((n, index) => h`${index === 0 ? '' : ' · '}${link(hrefPath(hrefOf(n)), NEXT_LABEL[n])}`)}</p>
    ${first === undefined ? '' : details(h`${kv(failed.slice(0, 20).map((s) => [s.label === '' ? '대상' : s.label, s.error ?? failureOf(s).headline] as [string, unknown]))}`)}`;
  return { title, body };
}

/** 내부 경로 문자열을 `link()` 가 받는 조각으로 (이미 인코딩된 경로를 풀었다가 다시 인코딩한다) */
function hrefPath(href: string): string[] {
  return href.split('?')[0]!.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
}
