// 데몬 설정(`phone`) → 전화 조립 옵션 (ADR-0014). 설정은 비밀값 자체가 아니라 비밀을 담은 *환경 변수의 이름*만 갖는다.
// 설정이 없으면 전화 Capability 는 조립되지 않는다(기존 동작). `provider` 는 지금 `vapi` 뿐이다 — 모르는 값과 모르는 키는 시작 때 거부한다.
// 정책(`phone:` 섹션)은 설정이 아니라 승인 경로로 배포되는 정책 문서에 있다. 이 설정은 provider 연결과 인바운드 라우팅(인스턴스 설정)만 다룬다.
import { isE164, validateInboundRoutes, type InboundRoute } from '@aot/domain';

import { createVapiAdapter } from './phone-vapi.ts';
import type { PhoneOptions } from './phone.ts';

export interface PhoneConfig {
  provider: 'vapi';
  /** Vapi private API key 가 든 환경 변수 이름 */
  api_key_env: string;
  /** webhook 비밀이 든 환경 변수 이름 */
  webhook_secret_env: string;
  /**
   * Vapi 어댑터의 계약 확인 날짜(YYYY-MM-DD). 필수다: 어댑터는 문서로 확인하지 못한 필드를 쓰므로(phone-vapi.ts `UNVERIFIED`), 사람이 수동 smoke
   * (`scripts/phone-vapi-smoke.ts`, docs/plans/phone-capability.md)를 마치고 날짜를 적기 전에는 실제 provider 로 데몬을 시작하지 않는다
   */
  vapi_contract_verified_on: string;
  /** 발신 번호(E.164) → Vapi phoneNumberId */
  phone_numbers: Record<string, string>;
  /** 업무 의도 키 → Vapi assistantId */
  assistants?: Record<string, string>;
  default_assistant_id?: string;
  /** 인바운드 라우팅 규칙 (domain 의 InboundRoute 형식). 없으면 모든 수신 통화를 거절한다 */
  inbound_routes?: unknown;
  /** 최대 통화시간 위에 더하는 유예(ms). 기본 300000 */
  grace_ms?: number;
  /** webhook 수신 리스너. 없으면 열지 않는다 — 노출은 배포 결정이다 (ADR-0014 §10) */
  webhook?: { host?: string; port: number; path?: string; allow_insecure?: boolean };
}

const isNonEmpty = (value: unknown): boolean => typeof value === 'string' && value !== '';

const KEYS = ['provider', 'api_key_env', 'webhook_secret_env', 'vapi_contract_verified_on', 'phone_numbers', 'assistants', 'default_assistant_id', 'inbound_routes', 'grace_ms', 'webhook'];

export interface BuiltPhoneConfig {
  options: PhoneOptions;
  webhook: { host: string; port: number; path: string } | null;
  routes: InboundRoute[];
}

export function phoneOptionsFromConfig(config: { phone?: PhoneConfig | null }, env: NodeJS.ProcessEnv = process.env): BuiltPhoneConfig | undefined {
  const phone = config.phone;
  if (phone === undefined || phone === null) return undefined;
  for (const key of Object.keys(phone)) if (!KEYS.includes(key)) throw new Error(`phone: unknown key '${key}'`);
  if (phone.provider !== 'vapi') throw new Error(`phone.provider '${String(phone.provider)}' is not supported (only 'vapi')`);
  if (typeof phone.vapi_contract_verified_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(phone.vapi_contract_verified_on)) {
    throw new Error('phone.vapi_contract_verified_on (YYYY-MM-DD) is required: run the manual Vapi smoke (scripts/phone-vapi-smoke.ts, docs/plans/phone-capability.md) and record its date before starting the daemon with a real provider');
  }
  const secret = (name: unknown, label: string): string => {
    if (typeof name !== 'string' || name === '') throw new Error(`phone.${label} must name an environment variable`);
    const value = env[name];
    if (value === undefined || value === '') throw new Error(`phone.${label}: environment variable ${name} is not set`);
    return value;
  };
  const numbers = phone.phone_numbers;
  if (typeof numbers !== 'object' || numbers === null || Object.keys(numbers).length === 0 || !Object.keys(numbers).every(isE164) || !Object.values(numbers).every(isNonEmpty)) {
    throw new Error('phone.phone_numbers must map E.164 caller ids to Vapi phone number ids');
  }
  if (phone.assistants !== undefined && (typeof phone.assistants !== 'object' || phone.assistants === null || !Object.values(phone.assistants).every(isNonEmpty))) throw new Error('phone.assistants must map objective keys to Vapi assistant ids');
  if (phone.default_assistant_id !== undefined && !isNonEmpty(phone.default_assistant_id)) throw new Error('phone.default_assistant_id must be a non-empty string');
  if (phone.grace_ms !== undefined && (!Number.isInteger(phone.grace_ms) || phone.grace_ms < 0)) throw new Error('phone.grace_ms must be a non-negative integer (milliseconds)');
  if (phone.webhook !== undefined) {
    const w = phone.webhook as unknown;
    if (typeof w !== 'object' || w === null) throw new Error('phone.webhook must be an object {host?, port, path?}');
    for (const key of Object.keys(w)) if (!['host', 'port', 'path', 'allow_insecure'].includes(key)) throw new Error(`phone.webhook: unknown key '${key}'`);
  }
  let routes: InboundRoute[] = [];
  if (phone.inbound_routes !== undefined) {
    const checked = validateInboundRoutes(phone.inbound_routes);
    if (!checked.ok) throw new Error(`phone.inbound_routes: ${checked.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    routes = checked.value;
  }
  const port = createVapiAdapter({
    apiKey: secret(phone.api_key_env, 'api_key_env'), webhookSecret: secret(phone.webhook_secret_env, 'webhook_secret_env'), phoneNumbers: numbers,
    ...(phone.assistants === undefined ? {} : { assistants: phone.assistants }),
    ...(phone.default_assistant_id === undefined ? {} : { defaultAssistantId: phone.default_assistant_id }),
  });
  if (phone.webhook !== undefined) {
    const host = (phone.webhook as { host?: unknown }).host ?? '127.0.0.1';
    // 이 리스너는 TLS 를 하지 않는다. 루프백이 아닌 주소에 묶으려면 앞단(프록시·터널)이 TLS 를 끝낸다는 사실을 명시적으로 인정해야 한다 — 비밀이 평문으로 오가는 것을 설정 실수로 열지 않게 한다
    const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
    if (!loopback && (phone.webhook as { allow_insecure?: unknown }).allow_insecure !== true) {
      throw new Error(`phone.webhook.host '${String(host)}' is not a loopback address: the listener does not speak TLS. Bind to 127.0.0.1 behind a TLS-terminating proxy, or set phone.webhook.allow_insecure=true to acknowledge that TLS is terminated in front of it`);
    }
  }
  const webhook = phone.webhook === undefined ? null : { host: phone.webhook.host ?? '127.0.0.1', port: phone.webhook.port, path: phone.webhook.path ?? '/phone/webhook' };
  if (webhook !== null && (!Number.isInteger(webhook.port) || webhook.port < 0 || webhook.port > 65535 || !webhook.path.startsWith('/'))) throw new Error('phone.webhook needs a port and a path starting with /');
  return {
    options: { port, inboundRoutes: routes, ...(phone.grace_ms === undefined ? {} : { graceMs: phone.grace_ms }) },
    webhook, routes,
  };
}
