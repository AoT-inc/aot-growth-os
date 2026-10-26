// PhonePort 계약 시험 (ADR-0014): 어떤 provider 어댑터든(가짜, Vapi, 이후의 Retell·Twilio) 같은 규칙을 지켜야 한다.
// 코어는 어댑터 이름과 canonical 이벤트만 신뢰하므로, 이 스위트가 "provider payload 가 코어로 새지 않는다"를 고정한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PhoneWebhookError, validatePhoneEvent, type PhonePort, type PhoneWebhookRequest } from '@aot/domain';

export interface PhonePortHarness {
  port: PhonePort;
  /** 인증을 통과하고 이벤트를 하나 이상 담은 요청 */
  valid: PhoneWebhookRequest;
  /** 비밀이 틀린(또는 없는) 요청 */
  forged: PhoneWebhookRequest;
  /** 인증은 맞지만 본문이 JSON 이 아닌 요청 */
  malformed: PhoneWebhookRequest;
  /** 어떤 canonical 이벤트에도 나타나서는 안 되는 값(비밀 등) */
  secrets: string[];
}

export function definePhonePortContract(label: string, make: () => PhonePortHarness): void {
  test(`${label} (PhonePort contract): the name is a lowercase adapter id`, () => {
    assert.match(make().port.name, /^[a-z][a-z0-9_-]{0,31}$/);
  });

  test(`${label} (PhonePort contract): a valid webhook becomes canonical events owned by this adapter, with stable ids`, () => {
    const { port, valid, secrets } = make();
    const first = port.parseWebhook(valid);
    assert.ok(first.events.length > 0);
    for (const event of first.events) {
      const checked = validatePhoneEvent(event);
      assert.ok(checked.ok, JSON.stringify(!checked.ok && checked.errors));
      assert.equal(event.provider, port.name);
    }
    // 같은 요청을 다시 받으면 같은 이벤트 id (재전송이 멱등 키로 흡수된다)
    assert.deepEqual(port.parseWebhook(valid).events.map((e) => e.eventId), first.events.map((e) => e.eventId));
    const serialized = JSON.stringify(first.events);
    for (const secret of secrets) assert.ok(!serialized.includes(secret), 'secrets never appear in canonical events');
  });

  test(`${label} (PhonePort contract): a forged or unsigned webhook is refused as unauthorized, a malformed one as malformed`, () => {
    const { port, forged, malformed } = make();
    assert.throws(() => port.parseWebhook(forged), (e) => e instanceof PhoneWebhookError && e.code === 'unauthorized');
    assert.throws(() => port.parseWebhook(malformed), (e) => e instanceof PhoneWebhookError && e.code === 'malformed');
  });
}
