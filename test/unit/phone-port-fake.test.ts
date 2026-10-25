import { createFakePhoneProvider } from '@aot/agent-runtime';

import { definePhonePortContract } from '../support/phone-port-contract.ts';

definePhonePortContract('fake provider', () => {
  const port = createFakePhoneProvider({ secret: 'contract-secret-1' });
  return {
    port,
    valid: port.webhook([{ kind: 'answered', id: 'c-1', call: 'prov-1', at: '2026-10-25T01:00:00.000Z' }, { kind: 'speech', id: 'c-2', call: 'prov-1', at: '2026-10-25T01:00:05.000Z', lines: [{ who: 'user', said: '네' }] }]),
    forged: port.webhook([{ kind: 'answered', id: 'c-1', call: 'prov-1', at: '2026-10-25T01:00:00.000Z' }], { secret: 'nope' }),
    malformed: { headers: { 'x-fake-secret': 'contract-secret-1' }, body: 'not json' },
    secrets: ['contract-secret-1'],
  };
});
