// 수동 smoke: 실제 Vapi 로 전화 *한 통*을 걸어 Vapi 어댑터가 가정한 계약(UNVERIFIED 필드)을 확인한다. 사람이 비공개 환경에서만 돌린다 — CI·시험·에이전트가 돌리지 않는다.
// 이 스크립트는 실제 전화를 건다. 그래서 확인 문구 환경 변수가 없으면 아무것도 보내지 않고 끝난다.
//
//   AOT_SMOKE_CONFIRM=place-one-real-call AOT_SMOKE_TO=<본인 번호 E.164> AOT_SMOKE_FROM=<Vapi 에 등록한 발신 번호 E.164> \
//   AOT_SMOKE_PHONE_NUMBER_ID=<Vapi phoneNumberId> AOT_SMOKE_ASSISTANT_ID=<테스트 assistant> \
//   AOT_VAPI_API_KEY=<키> AOT_VAPI_WEBHOOK_SECRET=<비밀> node scripts/phone-vapi-smoke.ts
//
// 하는 일: 통화 생성(startCall) → 조회(fetchCallEvents)로 상태를 따라가기 → 끝나면 원본 응답의 필드 존재 여부를 확인 → 아직 통화 중이면 끊기.
// 출력은 정제된 보고서(JSON)뿐이다: 번호·발화·키는 출력하지 않고, 필드가 있는지/받아들여졌는지의 불리언과 개수만 낸다.
// 보고서를 PR/docs/plans/phone-capability.md 에 붙여 "UNVERIFIED" 항목을 확인됨으로 바꾼다. webhook 수신(서명/비밀, end-of-call-report 도착)은
// 이 스크립트가 보지 않는다 — 계획 문서의 수동 절차 4번으로 따로 확인한다.
import { createVapiAdapter } from '../apps/daemon/src/phone-vapi.ts';

const need = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return value;
};

if (process.env['AOT_SMOKE_CONFIRM'] !== 'place-one-real-call') {
  console.error('This script places one REAL phone call. Set AOT_SMOKE_CONFIRM=place-one-real-call to proceed (see the header comment).');
  process.exit(2);
}

const to = need('AOT_SMOKE_TO');
const from = need('AOT_SMOKE_FROM');
const apiKey = need('AOT_VAPI_API_KEY');
const timeoutMs = Number(process.env['AOT_SMOKE_TIMEOUT_S'] ?? '180') * 1000;

const port = createVapiAdapter({
  apiKey, webhookSecret: need('AOT_VAPI_WEBHOOK_SECRET'), phoneNumbers: { [from]: need('AOT_SMOKE_PHONE_NUMBER_ID') }, defaultAssistantId: need('AOT_SMOKE_ASSISTANT_ID'),
});

const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
const has = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

try {
  const accepted = await port.startCall({
    callId: 'call-smoke', effectKey: 'smoke'.padEnd(40, '0'), to, from, objective: 'smoke_test', context: { smoke: true },
    maxDurationSeconds: 120, allowTransfer: false, recording: false,
  });
  report['startCall'] = { accepted: true, status: accepted.status, hasProviderCallId: has(accepted.providerCallId) };

  const seen = new Set<string>();
  const types: string[] = [];
  const deadline = Date.now() + timeoutMs;
  let finished = false;
  while (Date.now() < deadline && !finished) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    for (const event of await port.fetchCallEvents(accepted.providerCallId)) {
      if (seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      types.push(event.type);
      if (event.type === 'phone.call.completed') {
        report['completed'] = {
          transcriptTurns: event.transcript?.turns.length ?? 0, hasAnalysis: event.analysis !== undefined, hasDisposition: event.analysis?.disposition !== undefined,
          hasCost: event.costUsd !== undefined, hasDuration: event.durationSeconds !== undefined, endedReason: event.endedReason ?? null,
        };
      }
      if (event.type === 'phone.call.completed' || event.type === 'phone.call.failed') finished = true;
    }
  }
  report['events'] = types;

  // 원본 응답의 필드 존재 여부 (UNVERIFIED 항목): 값은 출력하지 않는다
  const raw = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(accepted.providerCallId)}`, { headers: { authorization: `Bearer ${apiKey}` } });
  const call = (await raw.json()) as Record<string, unknown>;
  const monitor = call['monitor'] as Record<string, unknown> | undefined;
  report['rawCall'] = {
    http: raw.status, status: call['status'] ?? null, hasMonitorControlUrl: has(monitor?.['controlUrl']), hasMessages: Array.isArray(call['messages']), hasAnalysis: has(call['analysis']),
    hasCost: typeof call['cost'] === 'number', hasEndedReason: has(call['endedReason']), hasStartedAt: has(call['startedAt']), hasEndedAt: has(call['endedAt']),
    hasArtifactRecordingUrl: has((call['artifact'] as Record<string, unknown> | undefined)?.['recordingUrl']), hasMetadata: has(call['metadata']) || has((call['assistantOverrides'] as Record<string, unknown> | undefined)?.['metadata']),
  };

  if (!finished) {
    await port.hangup(accepted.providerCallId); // controlUrl 경로(UNVERIFIED)도 이때 확인된다
    report['hangup'] = { sent: true };
  }
  report['finished'] = finished;
} catch (error) {
  report['error'] = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'; // 어댑터 오류 메시지에는 응답 본문과 키가 들어 있지 않다
  process.exitCode = 1;
}
report['endedAt'] = new Date().toISOString();
console.log(JSON.stringify(report, null, 2));
