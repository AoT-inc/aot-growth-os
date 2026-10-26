// claude-code-cli 고지 동의 채널 (가드레일 4): 사람 승인 채널(Unix 소켓, trust-boundaries §3.1)에 얹은 `consent` 명령.
// 소켓 처리기 조합(assemble.ts)이 이 명령만 여기로 보내고 나머지는 다른 채널·승인 엔진으로 넘긴다.
//
// 동의는 스키마를 바꾸지 않고 `event` 행으로 남긴다(source='consent', type='consent.accepted'|'consent.revoked'). 가장 나중 행이 현재 상태다.
// 어댑터는 run 을 시작할 때마다 `readClaudeCodeConsent` 를 불러 읽으므로 동의·철회가 데몬 재시작 없이 다음 run 부터 적용된다.
// 동의는 *현재 고지 판*(`CLAUDE_CODE_NOTICE.version`)에만 유효하다: 문구가 바뀌면 이전 동의는 인정되지 않고 어댑터는 `consent_required`(→ needs_review)로 끝난다.
//
// 인증 경계: 승인 CLI 와 같다 — 소켓 파일 권한(0700 디렉터리 + 0600 소켓)과 요청의 actor 가 `actor.kind='human'` 인지 확인. TOTP 는 요구하지 않는다
// (정책 변경도 외부 부작용도 아니고, 사람이 고지를 읽었다는 확인이다). 에이전트는 컨테이너 안에서 돌며 소켓이 보이지 않는다(Q26).
//
// 요청 (한 줄 JSON, 허용 키: cmd, actor, op, notice_version):
//   {cmd:'consent', actor, op:'show'}                                → 현재 고지(판·문구)와 동의 상태
//   {cmd:'consent', actor, op:'accept', notice_version}              → 현재 판과 같을 때만 기록 (사람이 `show` 로 본 판을 직접 적는다)
//   {cmd:'consent', actor, op:'revoke'}                              → 철회 기록 (이후 run 은 consent_required)
// 응답: {ok:true, ...} 또는 {ok:false, code, error}. 코드: invalid_request, unknown_actor, not_human, unknown_op, notice_version_required, notice_version_mismatch.
import { randomUUID } from 'node:crypto';

import { CLAUDE_CODE_ADAPTER_NAME, CLAUDE_CODE_NOTICE, type ClaudeCodeConsent } from '@aot/agent-runtime';
import type { Clock, Db } from '@aot/domain';

export const CONSENT_COMMANDS = ['consent'] as const;
export const CONSENT_EVENT_SOURCE = 'consent';
export const CONSENT_ACCEPTED = 'consent.accepted';
export const CONSENT_REVOKED = 'consent.revoked';

type ConsentRow = { type: string; payload: string; occurred_at: string };

interface ConsentState {
  accepted: boolean;
  /** 마지막 동의 기록의 고지 판 (철회됐으면 null) */
  noticeVersion: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
}

/** 이 어댑터에 대한 가장 나중 동의·철회 기록. 같은 시각이어도 나중에 넣은 행이 이긴다(rowid) */
function latest(db: Db): ConsentRow | undefined {
  return db.get<ConsentRow>(
    'SELECT type, payload, occurred_at FROM event WHERE source = ? AND external_id = ? ORDER BY rowid DESC LIMIT 1',
    [CONSENT_EVENT_SOURCE, CLAUDE_CODE_ADAPTER_NAME],
  );
}

function stateOf(db: Db): ConsentState {
  const row = latest(db);
  if (row === undefined || row.type !== CONSENT_ACCEPTED) return { accepted: false, noticeVersion: null, acceptedAt: null, acceptedBy: null };
  const payload = JSON.parse(row.payload) as { notice_version?: unknown; actor_id?: unknown };
  return {
    accepted: true,
    noticeVersion: typeof payload.notice_version === 'string' ? payload.notice_version : null,
    acceptedAt: row.occurred_at,
    acceptedBy: typeof payload.actor_id === 'string' ? payload.actor_id : null,
  };
}

/**
 * 어댑터에 넘기는 동의 기록. 마지막 기록이 *현재 고지 판*에 대한 동의일 때만 값을 돌려주고, 아니면(없음·철회·낡은 판) null.
 * 어댑터의 `consent` 옵션에 이 함수를 그대로 넘긴다.
 */
export function readClaudeCodeConsent(db: Db): ClaudeCodeConsent | null {
  const state = stateOf(db);
  if (!state.accepted || state.noticeVersion !== CLAUDE_CODE_NOTICE.version || state.acceptedAt === null) return null;
  return { notice_version: state.noticeVersion, accepted_at: state.acceptedAt };
}

export interface ConsentChannelOptions {
  db: Db;
  clock: Clock;
}

/** 이 요청이 동의 명령인가 (소켓 처리기 조합이 고르는 기준) */
export function isConsentCommand(request: unknown): boolean {
  return typeof request === 'object' && request !== null && !Array.isArray(request)
    && (CONSENT_COMMANDS as readonly unknown[]).includes((request as Record<string, unknown>)['cmd']);
}

const KEYS = ['cmd', 'actor', 'op', 'notice_version'];

const refused = (code: string, error: string): Record<string, unknown> => ({ ok: false, code, error });

export function createConsentHandler(options: ConsentChannelOptions): (request: unknown) => Record<string, unknown> {
  const { db, clock } = options;
  const view = (state: ConsentState): Record<string, unknown> => ({
    accepted: state.accepted && state.noticeVersion === CLAUDE_CODE_NOTICE.version,
    // 동의했지만 고지 문구가 그 뒤 바뀌었다: 다시 동의해야 한다
    stale: state.accepted && state.noticeVersion !== CLAUDE_CODE_NOTICE.version,
    notice_version: state.noticeVersion,
    accepted_at: state.acceptedAt,
    accepted_by: state.acceptedBy,
  });

  const record = (type: string, payload: Record<string, unknown>): void => {
    db.writeTx((tx) => {
      const id = `event-${randomUUID()}`;
      const now = clock.nowIso();
      tx.run(
        `INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        [id, CONSENT_EVENT_SOURCE, CLAUDE_CODE_ADAPTER_NAME, type, JSON.stringify(payload), `consent:${CLAUDE_CODE_ADAPTER_NAME}:${id}`, now, now],
      );
    });
  };

  return (raw) => {
    const request = raw as Record<string, unknown>;
    const actorId = request['actor'];
    if (typeof actorId !== 'string' || actorId === '') return refused('unknown_actor', 'an actor id is required');
    const actor = db.get<{ kind: string }>('SELECT kind FROM actor WHERE id = ?', [actorId]);
    if (!actor) return refused('unknown_actor', `unknown actor '${actorId}'`);
    if (actor.kind !== 'human') return refused('not_human', `only human actors can use the consent channel; '${actorId}' is '${actor.kind}'`);
    const unknown = Object.keys(request).filter((key) => !KEYS.includes(key));
    if (unknown.length > 0) return refused('invalid_request', `unknown field(s): ${unknown.join(', ')}`);

    const op = request['op'];
    const version = request['notice_version'];
    if (op !== 'accept' && version !== undefined) return refused('invalid_request', 'notice_version is only for accept');
    switch (op) {
      case 'show':
        return { ok: true, adapter: CLAUDE_CODE_ADAPTER_NAME, notice: { version: CLAUDE_CODE_NOTICE.version, text: CLAUDE_CODE_NOTICE.text }, consent: view(stateOf(db)) };
      case 'accept': {
        if (typeof version !== 'string' || version === '') return refused('notice_version_required', 'accept needs the notice version you read (see `consent show`)');
        if (version !== CLAUDE_CODE_NOTICE.version) {
          return refused('notice_version_mismatch', `the current notice is version '${CLAUDE_CODE_NOTICE.version}', not '${version}'; read it with \`consent show\``);
        }
        const before = stateOf(db);
        if (before.accepted && before.noticeVersion === CLAUDE_CODE_NOTICE.version) return { ok: true, applied: false, consent: view(before) };
        record(CONSENT_ACCEPTED, { adapter: CLAUDE_CODE_ADAPTER_NAME, notice_version: CLAUDE_CODE_NOTICE.version, actor_id: actorId });
        return { ok: true, applied: true, consent: view(stateOf(db)) };
      }
      case 'revoke': {
        const before = stateOf(db);
        if (!before.accepted) return { ok: true, applied: false, consent: view(before) };
        record(CONSENT_REVOKED, { adapter: CLAUDE_CODE_ADAPTER_NAME, actor_id: actorId });
        return { ok: true, applied: true, consent: view(stateOf(db)) };
      }
      default:
        return refused('unknown_op', 'op must be show|accept|revoke');
    }
  };
}
