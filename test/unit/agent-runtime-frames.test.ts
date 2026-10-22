// A5 U1: 게이트웨이 통신 프레임 (스파이크 Q26 §3). 형식 오류·크기 초과·방향 위반은 예외가 아니라 거부 결과로 돌아온다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodeFrame, MAX_FRAME_BYTES, parseFrame, validateCostProgress, type Frame, type FrameRejectCode } from '@aot/agent-runtime';

const AT = '2026-10-22T00:00:00.000Z';
const resultFrame = {
  type: 'result', status: 'submitted', result: { a: 1 }, evidence: [{ kind: 'source_url', ref: 'https://example.com/', captured_at: AT }],
  run_log: [{ at: AT, message: 'done' }], cost: { usd: 0.03 },
};

function rejectCode(line: string, direction: 'agent_to_host' | 'host_to_agent' = 'agent_to_host'): FrameRejectCode {
  const parsed = parseFrame(line, direction);
  assert.equal(parsed.ok, false, `expected rejection: ${line.slice(0, 80)}`);
  return parsed.ok ? 'empty' : parsed.rejection.code;
}

describe('frame format (spike Q26 §3)', () => {
  it('parses the four frame types in their direction, with the spike example shapes', () => {
    const toolCall = parseFrame('{"type":"tool_call","id":1,"tool":"fetch_url","args":{"url":"https://example.com/"}}', 'agent_to_host');
    assert.deepEqual(toolCall.ok && toolCall.frame, { type: 'tool_call', id: 1, tool: 'fetch_url', args: { url: 'https://example.com/' } });
    const progress = parseFrame('{"type":"cost_progress","cumulative":0.02,"unit":"usd"}', 'agent_to_host');
    assert.ok(progress.ok);
    assert.ok(parseFrame(JSON.stringify(resultFrame), 'agent_to_host').ok);
    assert.ok(parseFrame('{"type":"tool_result","id":1,"result":{"status":200}}', 'host_to_agent').ok);
    assert.ok(parseFrame('{"type":"tool_result","id":3,"error":"tool_not_allowed"}', 'host_to_agent').ok);
    assert.ok(parseFrame('{"type":"tool_result","id":4,"result":null}', 'host_to_agent').ok, 'a null result is a result');
  });

  it('rejects the wrong direction: an agent cannot send tool_result, the host never receives it, and vice versa', () => {
    assert.equal(rejectCode('{"type":"tool_result","id":1,"result":1}', 'agent_to_host'), 'unexpected_direction');
    assert.equal(rejectCode('{"type":"tool_call","id":1,"tool":"x","args":{}}', 'host_to_agent'), 'unexpected_direction');
    assert.equal(rejectCode(JSON.stringify(resultFrame), 'host_to_agent'), 'unexpected_direction');
  });

  it('rejects malformed input with a reason code instead of throwing', () => {
    assert.equal(rejectCode(''), 'empty');
    assert.equal(rejectCode('   '), 'empty');
    assert.equal(rejectCode('not json'), 'not_json');
    assert.equal(rejectCode('{"type":"tool_call"'), 'not_json');
    assert.equal(rejectCode('[1,2]'), 'not_object');
    assert.equal(rejectCode('"text"'), 'not_object');
    assert.equal(rejectCode('{"id":1}'), 'unknown_type');
    assert.equal(rejectCode('{"type":"shell","cmd":"ls"}'), 'unknown_type');
    assert.equal(rejectCode('{"type":"tool_call","id":1,\n"tool":"x","args":{}}'), 'multiple_lines');
    assert.equal(rejectCode('{"type":"tool_call","id":1,"tool":"x","args":{}}\r'), 'multiple_lines');
  });

  it('rejects frames with bad fields and reports which fields', () => {
    const bad = [
      '{"type":"tool_call","id":0,"tool":"x","args":{}}',
      '{"type":"tool_call","id":1.5,"tool":"x","args":{}}',
      '{"type":"tool_call","id":1,"tool":"","args":{}}',
      '{"type":"tool_call","id":1,"tool":"x","args":[]}',
      '{"type":"tool_call","id":1,"tool":"x","args":{},"extra":true}',
      '{"type":"cost_progress","cumulative":-1,"unit":"usd"}',
      '{"type":"cost_progress","cumulative":1,"unit":"eur"}',
      '{"type":"cost_progress","cumulative":0.5,"unit":"tokens"}',
      '{"type":"cost_progress","cumulative":1}',
      JSON.stringify({ ...resultFrame, evidence: undefined }),
      JSON.stringify({ ...resultFrame, cost: {} }),
      JSON.stringify({ ...resultFrame, status: 'done' }),
    ];
    for (const line of bad) assert.equal(rejectCode(line), 'invalid_frame', line);
    const parsed = parseFrame('{"type":"tool_call","id":0,"tool":"","args":[]}', 'agent_to_host');
    assert.ok(!parsed.ok && parsed.rejection.issues?.map((i) => i.path).sort().join() === 'args,id,tool');
    assert.equal(rejectCode('{"type":"tool_result","id":1}', 'host_to_agent'), 'invalid_frame');
    assert.equal(rejectCode('{"type":"tool_result","id":1,"result":1,"error":"x"}', 'host_to_agent'), 'invalid_frame');
    assert.equal(rejectCode('{"type":"tool_result","id":1,"error":""}', 'host_to_agent'), 'invalid_frame');
  });

  it('enforces the maximum frame size in UTF-8 bytes (boundary included)', () => {
    const wrap = (text: string) => JSON.stringify({ type: 'tool_call', id: 1, tool: 'x', args: { text } });
    const overhead = Buffer.byteLength(wrap(''), 'utf8');
    const exact = wrap('a'.repeat(MAX_FRAME_BYTES - overhead));
    assert.equal(Buffer.byteLength(exact, 'utf8'), MAX_FRAME_BYTES);
    assert.ok(parseFrame(exact, 'agent_to_host').ok);
    assert.equal(rejectCode(wrap('a'.repeat(MAX_FRAME_BYTES - overhead + 1))), 'too_large');
    // 문자 수는 한도 이하여도 바이트가 넘으면 거부한다
    assert.equal(rejectCode(wrap('가'.repeat(Math.ceil(MAX_FRAME_BYTES / 3)))), 'too_large');
    const big = encodeFrame({ type: 'tool_call', id: 1, tool: 'x', args: { text: 'a'.repeat(MAX_FRAME_BYTES) } });
    assert.ok(!big.ok && big.rejection.code === 'too_large');
  });

  it('encodes to a single line that parses back to the same frame', () => {
    const frames: Frame[] = [
      { type: 'tool_call', id: 7, tool: 'fetch_url', args: { url: 'https://example.com/', note: '줄\n바꿈 포함' } },
      { type: 'tool_result', id: 7, result: { status: 200 } },
      { type: 'tool_result', id: 8, error: 'tool_not_allowed' },
      { type: 'cost_progress', cumulative: 120, unit: 'tokens' },
      resultFrame as Frame,
    ];
    for (const frame of frames) {
      const encoded = encodeFrame(frame);
      assert.ok(encoded.ok);
      assert.ok(!encoded.line.includes('\n'));
      const direction = frame.type === 'tool_result' ? 'host_to_agent' : 'agent_to_host';
      const parsed = parseFrame(encoded.line, direction);
      assert.deepEqual(parsed.ok && parsed.frame, frame);
    }
  });

  it('encodeFrame refuses invalid or non-serializable frames instead of throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    for (const frame of [null, 'x', { type: 'nope' }, { type: 'tool_call', id: 1, tool: 'x', args: cyclic }, { type: 'tool_call', id: 1, tool: 'x', args: { n: 1n } }, { type: 'tool_result', id: 1, result: undefined }]) {
      const encoded = encodeFrame(frame);
      assert.equal(encoded.ok, false);
    }
  });
});

describe('cost_progress validation', () => {
  it('accepts usd and integer tokens, rejects the rest', () => {
    assert.ok(validateCostProgress({ cumulative: 0, unit: 'usd' }).ok);
    assert.ok(validateCostProgress({ cumulative: 10, unit: 'tokens' }).ok);
    assert.equal(validateCostProgress({ cumulative: Number.NaN, unit: 'usd' }).ok, false);
    assert.equal(validateCostProgress({ cumulative: 1.5, unit: 'tokens' }).ok, false);
    assert.equal(validateCostProgress({ cumulative: 1, unit: 'usd', extra: 1 }).ok, false);
    assert.equal(validateCostProgress(null).ok, false);
  });
});
