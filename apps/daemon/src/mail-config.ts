// 데몬 설정(`mail`) → 메일 조립 옵션 (ADR-0017 §8·§9). 설정은 비밀값 자체가 아니라 비밀을 담은 *환경 변수의 이름*만 갖는다 (phone-config.ts 와 같다).
// 설정이 없으면 메일 도구는 조립되지 않는다(기존 동작). 모르는 키·모르는 값은 시작 때 거부한다.
import { readFileSync } from 'node:fs';

import { domainOfAddress, FREE_MAIL_DOMAINS, isStrictDomain, normalizeAddress } from '@aot/domain';

import { createSmtpTransport, MAX_SMTP_TOTAL_MS, type SmtpSecurity } from './mail-smtp.ts';
import type { MailOptions } from './mail.ts';

export interface MailConfig {
  provider: 'smtp';
  smtp: {
    host: string;
    port: number;
    security: SmtpSecurity;
    /** SMTP 사용자 이름이 든 환경 변수 이름 (password_env 와 함께) */
    username_env?: string;
    /** SMTP 비밀번호가 든 환경 변수 이름 (username_env 와 함께) */
    password_env?: string;
    /** 서버 인증서를 검증할 CA PEM 파일 (시험·사설 릴레이용). 인증서 검증을 끄는 설정은 없다 */
    ca_file?: string;
    timeouts?: { connect_ms?: number; command_ms?: number; total_ms?: number };
  };
  /** 보내는 사람 키(명세의 `mail:<키>`) → 주소 */
  senders: Record<string, { address: string }>;
  /** 모든 메일의 List-Unsubscribe mailto 주소 */
  unsubscribe_mailto: string;
  /** envelope-from(반송 주소). 없으면 보내는 사람 주소 */
  bounce_address?: string;
  /** Message-ID 의 도메인. 없으면 보내는 사람 주소의 도메인 */
  message_id_domain?: string;
  /** 하루 전송 수 상한. 기본 200 */
  max_per_day?: number;
  /** 전송 사이 최소 간격(ms). 기본 1000 */
  min_interval_ms?: number;
}

const KEYS = ['provider', 'smtp', 'senders', 'unsubscribe_mailto', 'bounce_address', 'message_id_domain', 'max_per_day', 'min_interval_ms'];
const SMTP_KEYS = ['host', 'port', 'security', 'username_env', 'password_env', 'ca_file', 'timeouts'];
const TIMEOUT_KEYS = ['connect_ms', 'command_ms', 'total_ms'];
const SENDER_KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const rejectUnknown = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label}: unknown key '${key}'`);
};
const positiveInt = (value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw new Error(`${label} must be a positive integer${max === Number.MAX_SAFE_INTEGER ? '' : ` up to ${max}`}`);
  return value;
};

export function mailOptionsFromConfig(config: { mail?: MailConfig | null }, env: NodeJS.ProcessEnv = process.env): MailOptions | undefined {
  const mail = config.mail as unknown;
  if (mail === undefined || mail === null) return undefined;
  if (!isRecord(mail)) throw new Error('mail must be an object');
  rejectUnknown(mail, KEYS, 'mail');
  if (mail['provider'] !== 'smtp') throw new Error(`mail.provider '${String(mail['provider'])}' is not supported (only 'smtp')`);

  // ===== smtp =====
  const smtp = mail['smtp'];
  if (!isRecord(smtp)) throw new Error('mail.smtp must be an object {host, port, security, ...}');
  rejectUnknown(smtp, SMTP_KEYS, 'mail.smtp');
  const host = smtp['host'];
  if (typeof host !== 'string' || host === '' || /[\s/]/.test(host)) throw new Error('mail.smtp.host must be a host name or address');
  const port = positiveInt(smtp['port'], 'mail.smtp.port', 65535);
  const security = smtp['security'];
  if (security !== 'starttls' && security !== 'tls' && security !== 'none') throw new Error("mail.smtp.security must be 'starttls', 'tls' or 'none'");
  const hasUser = smtp['username_env'] !== undefined;
  const hasPass = smtp['password_env'] !== undefined;
  if (hasUser !== hasPass) throw new Error('mail.smtp.username_env and mail.smtp.password_env must be set together');
  if (security === 'none') {
    // 평문 연결은 루프백(로컬 릴레이·시험)에만 허용하고, 평문 AUTH 가 나갈 길은 설정으로도 만들지 못한다
    if (!LOOPBACK.includes(host)) throw new Error("mail.smtp.security 'none' is only allowed for a loopback host (127.0.0.1, ::1, localhost)");
    if (hasUser) throw new Error("mail.smtp.security 'none' cannot be combined with credentials (username_env/password_env)");
  }
  const secret = (name: unknown, label: string): string => {
    if (typeof name !== 'string' || name === '') throw new Error(`mail.smtp.${label} must name an environment variable`);
    const value = env[name];
    if (value === undefined || value === '') throw new Error(`mail.smtp.${label}: environment variable ${name} is not set`);
    return value;
  };
  const username = hasUser ? secret(smtp['username_env'], 'username_env') : undefined;
  const password = hasPass ? secret(smtp['password_env'], 'password_env') : undefined;
  let ca: string | undefined;
  if (smtp['ca_file'] !== undefined) {
    if (typeof smtp['ca_file'] !== 'string' || smtp['ca_file'] === '') throw new Error('mail.smtp.ca_file must be a file path');
    try {
      ca = readFileSync(smtp['ca_file'], 'utf8');
    } catch {
      throw new Error('mail.smtp.ca_file: the file cannot be read');
    }
  }
  let timeouts: { connectMs?: number; commandMs?: number; totalMs?: number } | undefined;
  if (smtp['timeouts'] !== undefined) {
    const t = smtp['timeouts'];
    if (!isRecord(t)) throw new Error('mail.smtp.timeouts must be an object {connect_ms?, command_ms?, total_ms?}');
    rejectUnknown(t, TIMEOUT_KEYS, 'mail.smtp.timeouts');
    timeouts = {
      ...(t['connect_ms'] === undefined ? {} : { connectMs: positiveInt(t['connect_ms'], 'mail.smtp.timeouts.connect_ms') }),
      ...(t['command_ms'] === undefined ? {} : { commandMs: positiveInt(t['command_ms'], 'mail.smtp.timeouts.command_ms') }),
      // 전체 전송 시간은 lease(기본 90초)보다 짧아야 전송 중 lease 를 잃지 않는다
      ...(t['total_ms'] === undefined ? {} : { totalMs: positiveInt(t['total_ms'], 'mail.smtp.timeouts.total_ms', MAX_SMTP_TOTAL_MS) }),
    };
  }

  // ===== senders =====
  const sendersRaw = mail['senders'];
  if (!isRecord(sendersRaw) || Object.keys(sendersRaw).length === 0) throw new Error('mail.senders must map sender keys to {address}');
  const senders: Record<string, { address: string }> = {};
  for (const [key, entry] of Object.entries(sendersRaw)) {
    if (!SENDER_KEY.test(key)) throw new Error(`mail.senders: key '${key}' must match ${SENDER_KEY.source}`);
    if (!isRecord(entry)) throw new Error(`mail.senders.${key} must be {address}`);
    rejectUnknown(entry, ['address'], `mail.senders.${key}`);
    const address = normalizeAddress(entry['address']);
    if (address === null || address !== entry['address']) throw new Error(`mail.senders.${key}.address must be a normalized address (lowercase, no display name)`);
    if (FREE_MAIL_DOMAINS.includes(domainOfAddress(address))) throw new Error(`mail.senders.${key}.address uses a public free-mail domain: its DMARC alignment breaks; use your own domain`);
    senders[key] = { address };
  }

  // ===== 그 밖 =====
  const unsubscribe = normalizeAddress(mail['unsubscribe_mailto']);
  if (unsubscribe === null || unsubscribe !== mail['unsubscribe_mailto']) throw new Error('mail.unsubscribe_mailto is required: a normalized address that receives unsubscribe requests');
  let bounceAddress: string | undefined;
  if (mail['bounce_address'] !== undefined) {
    const bounce = normalizeAddress(mail['bounce_address']);
    if (bounce === null || bounce !== mail['bounce_address']) throw new Error('mail.bounce_address must be a normalized address');
    bounceAddress = bounce;
  }
  let messageIdDomain: string | undefined;
  if (mail['message_id_domain'] !== undefined) {
    if (typeof mail['message_id_domain'] !== 'string' || !isStrictDomain(mail['message_id_domain'])) throw new Error('mail.message_id_domain must be a domain name (lowercase)');
    messageIdDomain = mail['message_id_domain'];
  }
  const maxPerDay = mail['max_per_day'] === undefined ? 200 : positiveInt(mail['max_per_day'], 'mail.max_per_day');
  const minIntervalMs = mail['min_interval_ms'] === undefined ? 1000 : mail['min_interval_ms'] === 0 ? 0 : positiveInt(mail['min_interval_ms'], 'mail.min_interval_ms');

  // EHLO 이름: 메시지 ID 도메인, 없으면 첫 보내는 사람의 도메인 (FQDN)
  const ehloName = messageIdDomain ?? domainOfAddress(Object.values(senders)[0]!.address);
  const transport = createSmtpTransport({
    host, port, security, ehloName,
    ...(username === undefined || password === undefined ? {} : { username, password }),
    ...(ca === undefined ? {} : { ca }),
    ...(timeouts === undefined ? {} : { timeouts }),
  });
  return {
    transport, senders, unsubscribeMailto: unsubscribe, maxPerDay, minIntervalMs,
    ...(bounceAddress === undefined ? {} : { bounceAddress }),
    ...(messageIdDomain === undefined ? {} : { messageIdDomain }),
  };
}
