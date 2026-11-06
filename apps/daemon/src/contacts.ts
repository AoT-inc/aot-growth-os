// 고객 연락처 채널 (결정 위임 D-B11, ADR-0016): 사람 승인 채널(Unix 소켓)에 얹은 `contacts` 명령. `contact` 표를 쓰는 유일한 경로다.
//  - 사람만 쓴다. 에이전트·위임 보유자·검토 화면(읽기 전용 DB)은 이 표에 쓰는 길이 없다.
//  - add·import 는 위임 범위를 넓히므로 사람 행위자 + 감사 기록(`event` source='contacts')이 전부다(TOTP 없음: 소켓 권한이 경계, consent 채널과 같다).
//  - suppress 는 좁히는 일이라 TOTP 없이 한다. 정지된 주소를 다시 active 로 되돌리는 경로는 v1 에 없다(add·import 는 정지된 주소를 건드리지 못한다).
// 요청 (한 줄 JSON): {cmd:'contacts', actor, op:'add', address, label?} | {op:'import', text} | {op:'suppress', address} | {op:'list'}
// 응답: {ok:true, ...} 또는 {ok:false, code, error}. 코드: unknown_actor, not_human, invalid_request, unknown_op, bad_address, suppressed, bad_import.
import { randomUUID } from 'node:crypto';

import { listContacts, normalizeAddress, type Clock, type ContactRow, type Db } from '@aot/domain';

export const CONTACTS_COMMANDS = ['contacts'] as const;
export const CONTACTS_EVENT_SOURCE = 'contacts';
export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_CHARS = 1_000_000;
export const MAX_LABEL_CHARS = 100;

export interface ContactsChannelOptions {
  db: Db;
  clock: Clock;
}

export function isContactsCommand(request: unknown): boolean {
  return typeof request === 'object' && request !== null && !Array.isArray(request)
    && (CONTACTS_COMMANDS as readonly unknown[]).includes((request as Record<string, unknown>)['cmd']);
}

const KEYS = ['cmd', 'actor', 'op', 'address', 'label', 'text'];
const refused = (code: string, error: string): Record<string, unknown> => ({ ok: false, code, error });

interface ImportLine { line: number; address: string; label: string | null }

/** CSV 또는 줄마다 하나인 글. 빈 줄·`#` 줄·`address` 머리글은 건너뛴다. 한 줄에 `주소[,이름]` */
export function parseContactImport(text: string): { lines: ImportLine[]; errors: string[] } {
  const lines: ImportLine[] = [];
  const errors: string[] = [];
  (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const comma = line.indexOf(',');
    const first = (comma < 0 ? line : line.slice(0, comma)).trim().replace(/^"(.*)"$/, '$1');
    const labelText = comma < 0 ? '' : line.slice(comma + 1).trim().replace(/^"(.*)"$/, '$1');
    if (index === 0 && /^(address|email|e-mail|이메일|주소)$/i.test(first)) return;
    const address = normalizeAddress(first);
    if (address === null) return void errors.push(`${index + 1}번째 줄: 이메일 주소로 읽을 수 없습니다`);
    if (labelText.length > MAX_LABEL_CHARS) return void errors.push(`${index + 1}번째 줄: 이름이 ${MAX_LABEL_CHARS}자를 넘습니다`);
    lines.push({ line: index + 1, address, label: labelText === '' ? null : labelText });
  });
  return { lines, errors };
}

export function createContactsHandler(options: ContactsChannelOptions): (request: unknown) => Record<string, unknown> {
  const { db, clock } = options;

  const audit = (tx: Db, type: string, payload: Record<string, unknown>): void => {
    const id = `event-${randomUUID()}`;
    const now = clock.nowIso();
    tx.run(
      `INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [id, CONTACTS_EVENT_SOURCE, String(payload['actor_id']), type, JSON.stringify(payload), `contacts:${id}`, now, now],
    );
  };

  /** 없으면 active 로 넣는다. 반환: 새로 넣음 / 이미 있음 / 정지되어 건드리지 않음 */
  const upsertActive = (tx: Db, address: string, label: string | null, actor: string): 'added' | 'existing' | 'suppressed' => {
    const row = tx.get<{ status: string; label: string | null }>('SELECT status, label FROM contact WHERE address = ?', [address]);
    if (row === undefined) {
      tx.run("INSERT INTO contact (address, label, status, added_by, added_at) VALUES (?, ?, 'active', ?, ?)", [address, label, actor, clock.nowIso()]);
      return 'added';
    }
    if (row.status === 'suppressed') return 'suppressed';
    if (label !== null && label !== row.label) tx.run('UPDATE contact SET label = ? WHERE address = ?', [label, address]);
    return 'existing';
  };

  return (raw) => {
    const request = raw as Record<string, unknown>;
    const actorId = request['actor'];
    if (typeof actorId !== 'string' || actorId === '') return refused('unknown_actor', 'an actor id is required');
    const actor = db.get<{ kind: string }>('SELECT kind FROM actor WHERE id = ?', [actorId]);
    if (!actor) return refused('unknown_actor', `unknown actor '${actorId}'`);
    if (actor.kind !== 'human') return refused('not_human', `only human actors can use the contacts channel; '${actorId}' is '${actor.kind}'`);
    const unknown = Object.keys(request).filter((key) => !KEYS.includes(key));
    if (unknown.length > 0) return refused('invalid_request', `unknown field(s): ${unknown.join(', ')}`);

    const op = request['op'];
    const labelRaw = request['label'];
    if (labelRaw !== undefined && (typeof labelRaw !== 'string' || labelRaw.length > MAX_LABEL_CHARS)) return refused('invalid_request', `label must be text up to ${MAX_LABEL_CHARS} characters`);
    const label = typeof labelRaw === 'string' && labelRaw.trim() !== '' ? labelRaw.trim() : null;

    switch (op) {
      case 'list': {
        const contacts = listContacts(db).map((row: ContactRow) => ({ ...row }));
        return { ok: true, contacts, active: contacts.filter((c) => c.status === 'active').length, suppressed: contacts.filter((c) => c.status === 'suppressed').length };
      }
      case 'add': {
        const address = normalizeAddress(request['address']);
        if (address === null) return refused('bad_address', 'the address is not a valid email address');
        const result = db.writeTx((tx) => {
          const outcome = upsertActive(tx, address, label, actorId);
          if (outcome === 'added') audit(tx, 'contact.added', { actor_id: actorId, address, label });
          return outcome;
        });
        if (result === 'suppressed') return refused('suppressed', 'this address is suppressed; suppression cannot be lifted');
        return { ok: true, address, applied: result === 'added' };
      }
      case 'import': {
        const text = request['text'];
        if (typeof text !== 'string' || text.trim() === '') return refused('invalid_request', 'import needs text (the file contents)');
        if (text.length > MAX_IMPORT_CHARS) return refused('bad_import', `the file is too large (over ${MAX_IMPORT_CHARS} characters)`);
        const parsed = parseContactImport(text);
        if (parsed.errors.length > 0) return { ...refused('bad_import', `nothing was imported: ${parsed.errors.slice(0, 10).join('; ')}`), errors: parsed.errors.slice(0, 50) };
        if (parsed.lines.length === 0) return refused('bad_import', 'no address found in the file');
        if (parsed.lines.length > MAX_IMPORT_ROWS) return refused('bad_import', `too many rows (over ${MAX_IMPORT_ROWS})`);
        const counts = { added: 0, existing: 0, suppressed: 0 };
        db.writeTx((tx) => {
          for (const line of parsed.lines) counts[upsertActive(tx, line.address, line.label, actorId)] += 1;
          audit(tx, 'contact.imported', { actor_id: actorId, rows: parsed.lines.length, ...counts });
        });
        return { ok: true, ...counts };
      }
      case 'suppress': {
        const address = normalizeAddress(request['address']);
        if (address === null) return refused('bad_address', 'the address is not a valid email address');
        const applied = db.writeTx((tx) => {
          const row = tx.get<{ status: string }>('SELECT status FROM contact WHERE address = ?', [address]);
          if (row?.status === 'suppressed') return false;
          const now = clock.nowIso();
          if (row === undefined) tx.run("INSERT INTO contact (address, label, status, added_by, added_at, suppressed_by, suppressed_at) VALUES (?, NULL, 'suppressed', ?, ?, ?, ?)", [address, actorId, now, actorId, now]);
          else tx.run("UPDATE contact SET status = 'suppressed', suppressed_by = ?, suppressed_at = ? WHERE address = ?", [actorId, now, address]);
          audit(tx, 'contact.suppressed', { actor_id: actorId, address });
          return true;
        });
        return { ok: true, address, applied };
      }
      default:
        return refused('unknown_op', 'op must be add|import|suppress|list');
    }
  };
}
