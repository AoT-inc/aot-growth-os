// claude-code-cli 검증기를 *실제 프로세스*로 시험한다 (가짜 claude 실행 파일). 가짜 포트 시험(test/unit/claude-code-verifier.test.ts)이 못 보는 것:
// 인자 배열(빈 문자열 `--tools ""`)이 실제 exec 를 거쳐도 유지되는지, stdin 파이프로 큰 프롬프트가 온전히 가는지, 환경이 네 개뿐인지, 작업 디렉터리가 비어 있는지.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createClaudeCodeGate, createClaudeCodeVerifier } from '@aot/agent-runtime';
import { FakeClock } from '@aot/domain';
import { buildIsolatedInput, VerifierUnavailableError } from '@aot/evaluation';

import { writeFakeVerifierClaude } from '../support/fake-claude-verifier.ts';
import { makeTempDir } from '../support/temp.ts';

const input = (text: string) => buildIsolatedInput({
  check: 'claim_supported_by_source',
  criteria: [],
  claims: [{ id: 'c1', statement: 'first', sourceRef: 'evidence:e1' }, { id: 'c2', statement: 'second', sourceRef: 'evidence:e1' }],
  sources: [{ ref: 'evidence:e1', kind: 'other', text, contentHash: null, trustOrigin: 'external_untrusted' }],
});

describe('claude-code-cli 검증기: 실제 프로세스', () => {
  it('stdin 으로 큰 프롬프트를 보내고, 도구 없는 호출 모양과 네 개뿐인 환경으로 실행한다', async (t) => {
    const dir = makeTempDir(t, 'aot-ccv-int-');
    const fake = writeFakeVerifierClaude(dir, { verdicts: { c1: 'supported', c2: 'supported' } });
    const clock = new FakeClock('2026-10-26T01:00:00.000Z');
    const verifier = createClaudeCodeVerifier({
      claudePath: fake.path, runRoot: join(dir, 'runs'), env: { home: dir, user: 'example-daemon', path: `${process.execPath.replace(/\/node$/, '')}:/usr/bin:/bin` },
      consent: { notice_version: 'n', accepted_at: '2026-10-26T00:00:00.000Z' }, clock, gate: createClaudeCodeGate({ clock }), model: 'opus-alias', maxSourceBytes: 600_000,
    });
    const big = `${'line of evidence text\n'.repeat(20_000)}TAIL-MARKER`; // 약 420 KB: 인자 상한(128 KiB)을 넘는다
    const verdict = await verifier.verify(input(big));
    assert.equal(verdict.verdict, 'supported');
    assert.equal(verdict.tokens, 15);
    const record = JSON.parse(readFileSync(fake.recordPath, 'utf8')) as { args: string[]; cwd: string; stdin: string; entries: string[] };
    assert.equal(record.args[record.args.indexOf('--tools') + 1], '');
    assert.ok(!record.args.includes('--allowedTools'));
    assert.ok(record.stdin.includes('TAIL-MARKER'), 'the whole prompt arrived through the pipe');
    assert.deepEqual(record.entries, [], 'the working directory is empty');
    assert.ok(record.cwd.endsWith('/work'));
  });

  it('한도 오류는 VerifierUnavailableError 로 올라오고 다음 호출은 프로세스를 띄우지 않는다', async (t) => {
    const dir = makeTempDir(t, 'aot-ccv-int-');
    const fake = writeFakeVerifierClaude(dir, { limit: true });
    const clock = new FakeClock('2026-10-26T01:00:00.000Z');
    const verifier = createClaudeCodeVerifier({
      claudePath: fake.path, runRoot: join(dir, 'runs'), env: { home: dir, user: 'example-daemon', path: `${process.execPath.replace(/\/node$/, '')}:/usr/bin:/bin` },
      consent: { notice_version: 'n', accepted_at: '2026-10-26T00:00:00.000Z' }, clock, gate: createClaudeCodeGate({ clock }), model: 'opus-alias',
    });
    await assert.rejects(verifier.verify(input('x')), (e: unknown) => e instanceof VerifierUnavailableError && e.code === 'usage_limit');
    const firstRecord = readFileSync(fake.recordPath, 'utf8');
    await assert.rejects(verifier.verify(input('x')), (e: unknown) => e instanceof VerifierUnavailableError && e.code === 'usage_limit' && /not retried before/.test(e.message));
    assert.equal(readFileSync(fake.recordPath, 'utf8'), firstRecord);
  });
});
