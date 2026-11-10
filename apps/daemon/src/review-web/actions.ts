// 결정 상자의 모델과 화면: 결정 하나는 "버튼" 여럿이고, 버튼 하나는 엔진에 보낼 요청("단계") 여럿이다(묶음은 업무마다 한 단계).
// 이 파일은 요청을 만들어 두기만 한다. 보내는 일은 decide.ts 가 하고, 검증·기록은 데몬의 승인 엔진만 한다(DB 는 여전히 읽기 전용).
// 폼에는 어떤 요청을 보낼지가 아니라 (결정 키, 버튼 이름, 본 내용의 지문, 발급 시각, nonce) 만 싣는다. 서버가 POST 때 같은 결정을 DB 에서 다시 만들어 지문이 같을 때만 보낸다.
import { createHash } from 'node:crypto';

import type { ReviewContext } from './context.ts';
import { escapeHtml, h, raw, type Raw } from './html.ts';

export interface Step {
  /** 결과 화면에서 이 단계를 부르는 이름(업무 제목 등) */
  label: string;
  /** 엔진 요청에서 actor·via·expected_hash·이유·OTP 를 뺀 나머지 */
  request: Record<string, unknown>;
  /** 사람이 본 내용의 엔진 해시(`show`). 없으면 null */
  hash: string | null;
  /** 이유가 들어갈 엔진 필드 (기본 comment, 효과 확정은 note) */
  textField?: 'comment' | 'note';
}

export type ReasonMode = 'none' | 'optional' | 'required';
export type Tone = 'yes' | 'no' | 'ch';

export interface Button {
  /** 결정 안에서 유일한 버튼 이름(폼으로 돌아온다) */
  verb: string;
  label: string;
  tone: Tone;
  steps: Step[];
  reason: ReasonMode;
  /** 이유 칸 이름표 */
  reasonLabel?: string;
  /** 6자리 OTP 입력이 필요한가 (정책이 재인증을 요구하는 결정만) */
  otp?: boolean;
  /** 접어 두고 요약 줄을 눌러야 입력이 보인다 */
  collapse?: boolean;
  /** 버튼 아래 한 줄 */
  note?: string;
  /** 성공했을 때 결과 화면의 한 줄 */
  done: string;
}

export interface Blocked {
  label: string;
  why: string;
}

export interface Actions {
  buttons: Button[];
  blocked: Blocked[];
  /** 그 밖의 안내 (예: 화면에서 할 수 없는 결정) */
  extra?: Raw | undefined;
}

export const noActions = (): Actions => ({ buttons: [], blocked: [] });

/** 버튼이 보내려는 것의 지문. 폼을 만든 뒤 내용(해시)이나 대상 집합이 바뀌면 달라진다 */
export function fingerprint(button: Button): string {
  return createHash('sha256').update(JSON.stringify([button.verb, button.steps.map((s) => [s.request, s.hash, s.textField ?? 'comment']), button.otp === true])).digest('hex');
}

/** 버튼 모양 */
export const TONE_CLASS: Readonly<Record<Tone, string>> = { yes: 'yes', no: 'no', ch: 'ch' };

const hidden = (name: string, value: string): Raw => raw(`<input type="hidden" name="${name}" value="${escapeHtml(value)}">`);

export const REASON_MAX_CHARS = 500;

export function buttonForm(ctx: ReviewContext, key: string, button: Button): Raw {
  const { issued, nonce } = ctx.forms.issue(button.verb, key, fingerprint(button), ctx.clock.nowMs());
  const reasonField = button.reason === 'none' ? h`` : button.reason === 'optional'
    ? h`<details class="why"><summary>${button.reasonLabel ?? '이유 남기기 (선택)'}</summary><textarea name="reason" rows="3" maxlength="${String(REASON_MAX_CHARS)}" aria-label="${button.reasonLabel ?? '이유 (선택)'}"></textarea></details>`
    : button.collapse === true
      ? h`<details class="why"><summary>${button.reasonLabel ?? '이유 쓰기 (필수)'}</summary><textarea name="reason" rows="3" required maxlength="${String(REASON_MAX_CHARS)}" aria-label="${button.reasonLabel ?? '이유 (필수)'}"></textarea></details>`
      : h`<label class="fld">${button.reasonLabel ?? '이유 (필수)'}<textarea name="reason" rows="3" required maxlength="${String(REASON_MAX_CHARS)}"></textarea></label>`;
  const otpField = button.otp === true
    ? h`<label class="fld">OTP 코드 (숫자 6자리)<input name="totp" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required></label>`
    : h``;
  return h`<form class="act" method="post" action="/decide">${hidden('key', key)}${hidden('verb', button.verb)}${hidden('hash', fingerprint(button))}${hidden('issued', issued)}${hidden('nonce', nonce)}${otpField}${button.reason === 'optional' ? '' : reasonField}<div class="row"><button type="submit" class="btn ${TONE_CLASS[button.tone]}">${button.label}</button>${button.note === undefined ? '' : h`<span class="rnote">${button.note}</span>`}</div>${button.reason === 'optional' ? reasonField : ''}</form>`;
}

/** 결정하기 상자. 쓰기가 꺼져 있으면(행위자 없음) 보기 전용 안내만 낸다 */
export function renderActions(ctx: ReviewContext, key: string, actions: Actions): Raw {
  const blocked = actions.blocked.map((b) => h`<div class="row"><span class="btn na">${b.label} 불가</span><span>${b.why}</span></div>`);
  if (ctx.write === null) {
    return h`<div class="decide"><h2>결정하기</h2><p class="mute">이 화면은 보기 전용으로 열려 있어 여기서 결정할 수 없습니다.${ctx.notice === null ? '' : h` ${ctx.notice}`}</p>${blocked}${actions.extra ?? ''}</div>`;
  }
  return h`<div class="decide"><h2>결정하기</h2>${blocked}${actions.buttons.map((b) => buttonForm(ctx, key, b))}${actions.extra ?? ''}</div>`;
}
