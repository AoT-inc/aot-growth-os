// MCP 도구의 게이트웨이 쪽과 부작용 원장 쪽 (ADR-0018 §2·§4·§6, 설계 §5.1·§5.2·§5.4).
//  - `mcpToolSpecs`: 에이전트에 내줄 도구는 오너 선언에서만 나온다(서버 목록이 아니다). 모든 결과는 `external_untrusted` 다.
//  - 읽기 실행기: 열림 확인 → 인자 1단계 검사 → 분당 상한(즉시 거부) → 커넥터 호출. 호출이 취소·시간 초과되면 서버에 취소를 보낸다.
//  - 쓰기 실행기: `bindToEffectLedger` 로 만든다. 열림 확인·인자 검사 뒤 원장 입구(`perform`)로만 보낸다. 서버 응답 본문은 에이전트에 돌려주지 않는다(상태만).
//  - 부작용 도구(`createMcpEffectTools`): 원장이 전송 단계에서 부른다. 보내기 직전에 목록을 다시 읽어 닫혔으면 보내지 않고 `failed`, 멱등 키 인자는 이때 호스트가 넣는다.
import { canonicalJson, sha256Hex } from '@aot/domain';

import type { JsonObject } from '../contract.ts';
import { bindToEffectLedger, type EffectLedgerRunner } from '../effect-ledger.ts';
import type { GatewayToolSpec, ToolExecutionRequest, ToolExecutionResult, ToolExecutor } from '../gateway.ts';

import type { McpSiteManifest, McpToolDecl } from './manifest.ts';
import { checkArguments } from './schema-pin.ts';
import { McpTransportError, type McpSiteClient } from './site-client.ts';

/** 읽기·쓰기 도구의 operation 이름. 정책 행위는 `mcp_<site>_<as>.call` */
export const MCP_OPERATION = 'call';

/** 에이전트에 내줄 수 있는 MCP 도구 선언. 명세의 `allowed_tools` 와 도구·operation 이 맞는 것만 그 run 에 열린다 */
export function mcpToolSpecs(manifest: McpSiteManifest): GatewayToolSpec[] {
  return manifest.tools.map((tool) => ({
    tool: tool.gatewayName, operation: MCP_OPERATION, target: tool.target, scope: tool.scope, impact: tool.impact, sideEffect: tool.sideEffect,
    resultOrigin: 'external_untrusted', timeoutMs: manifest.timeoutMs,
    ...(tool.unitCostUsd === null ? {} : { unitCost: { usd: tool.unitCostUsd } }),
  }));
}

/** 에이전트에 보이는 도구 설명: 오너가 쓴 문장뿐이다(서버가 알린 설명은 어디에도 쓰지 않는다) */
export function mcpToolDescriptions(manifests: readonly McpSiteManifest[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const manifest of manifests) for (const tool of manifest.tools) out[tool.gatewayName] = tool.description;
  return out;
}

const reasonOf = (site: McpSiteClient, tool: McpToolDecl): string | null => {
  const state = site.stateOf(tool.gatewayName);
  return state.status === 'open' ? null : `closed:${state.reason}`;
};

/** 열림과 인자를 확인한다. 문제가 있으면 사유 문구, 없으면 null */
function preflight(site: McpSiteClient, tool: McpToolDecl, args: unknown): string | null {
  const closed = reasonOf(site, tool);
  if (closed !== null) return `mcp tool ${tool.gatewayName} is ${closed}`;
  const problem = checkArguments(site.schemaOf(tool.gatewayName), args);
  if (problem !== null) return `mcp tool ${tool.gatewayName}: ${problem}`;
  if (tool.idempotency !== null && args !== null && typeof args === 'object' && Object.hasOwn(args, tool.idempotency.keyArgument)) {
    return `mcp tool ${tool.gatewayName}: '${tool.idempotency.keyArgument}' is set by the host and must not be supplied`;
  }
  return null;
}

/** 읽기 도구 하나의 실행기 */
function readExecutor(manifest: McpSiteManifest, site: McpSiteClient, tool: McpToolDecl): ToolExecutor {
  return async (request: ToolExecutionRequest): Promise<ToolExecutionResult> => {
    const problem = preflight(site, tool, request.args);
    if (problem !== null) throw new Error(problem);
    if (!site.tryAcquire()) throw new Error(`mcp site ${manifest.site}: rate limit of ${manifest.rateLimitPerMinute} calls per minute reached`);
    // 게이트웨이 타임아웃(= timeout_ms)이 먼저 끝나 신호가 abort 되면 사이트 연결이 서버에 취소를 보낸다. 호스트 타이머는 그보다 1초 늦다(응답을 잃은 커넥터 대비)
    const outcome = await site.call(tool.name, { ...request.args }, { timeoutMs: manifest.timeoutMs + 1000, signal: request.signal, retrySafe: true });
    if (!outcome.ok) throw new Error(`mcp ${tool.gatewayName}: ${outcome.error.code}: ${outcome.error.message}`);
    const { result } = outcome;
    return {
      result: {
        site: manifest.site, tool: tool.as, trust_origin: 'external_untrusted', is_error: result.is_error, text: result.text,
        ...(result.structured === undefined ? {} : { structured: result.structured as never }),
        ...(result.truncated === true ? { truncated: true } : {}),
        ...(Object.keys(result.dropped).length === 0 ? {} : { dropped: result.dropped }),
      } satisfies JsonObject,
    };
  };
}

export interface McpLedgerStep { stepId: string; action: string; target: string; request: unknown }
export interface McpLedgerOutcome { state: 'confirmed' | 'failed' | 'unknown' | 'compensated' | 'drafted'; effectId?: string; draftId?: string }
export type McpEffectRunner = EffectLedgerRunner<McpLedgerStep, McpLedgerOutcome>;

/** 쓰기 도구 하나의 실행기 (원장에 묶임). 같은 인자는 같은 단계(stepId)다 */
function writeExecutor(site: McpSiteClient, tool: McpToolDecl, ledger: McpEffectRunner): ToolExecutor {
  return bindToEffectLedger<ToolExecutionRequest, ToolExecutionResult, McpLedgerStep, McpLedgerOutcome>({
    ledger,
    run: async (request, perform) => {
      const problem = preflight(site, tool, request.args);
      if (problem !== null) throw new Error(problem);
      const args = request.args as JsonObject;
      const outcome = await perform(tool.gatewayName, {
        stepId: `mcp-${sha256Hex(canonicalJson(args)).slice(0, 16)}`, action: MCP_OPERATION, target: tool.target, request: { arguments: args },
      });
      return { result: outcome.state === 'drafted' ? { status: 'drafted', draft_id: outcome.draftId ?? null } : { status: outcome.state, effect_id: outcome.effectId ?? null } };
    },
  }) as unknown as ToolExecutor;
}

/** run 하나의 MCP 도구 실행기. 쓰기는 `ledger`(= RunContext.performEffect)로만 보낸다 */
export function createMcpToolExecutors(manifest: McpSiteManifest, site: McpSiteClient, ledger: McpEffectRunner): Map<string, ToolExecutor> {
  const out = new Map<string, ToolExecutor>();
  for (const tool of manifest.tools) out.set(tool.gatewayName, tool.sideEffect ? writeExecutor(site, tool, ledger) : readExecutor(manifest, site, tool));
  return out;
}

/** task-engine 의 EffectTool 과 구조가 같다 (agent-runtime 은 task-engine 을 import 하지 않는다) */
export interface McpEffectTool {
  readonly name: string;
  readonly actions: Readonly<Record<string, { readonly approval: 'draft' | 'scope'; readonly idempotency: { readonly supported: false } | { readonly supported: true; readonly retention_ms: number } }>>;
  send(call: { effectKey: string; action: string; target: string; request: unknown }): Promise<{ status: 'confirmed' | 'failed'; responseRef: string | null }>;
}

/** 부작용 도구: 쓰기 선언마다 하나. 원장이 전송 단계에서 부르고, 서버 호출은 여기서만 일어난다 */
export function createMcpEffectTools(manifest: McpSiteManifest, site: McpSiteClient): Record<string, McpEffectTool> {
  const out: Record<string, McpEffectTool> = {};
  for (const tool of manifest.tools) {
    if (!tool.sideEffect || tool.approval === null) continue;
    out[tool.gatewayName] = {
      name: tool.gatewayName,
      // 조회(lookup)가 없는 도구는 effect_key_carrier 를 선언할 수 없다(idempotency.ts). 멱등 키는 인자(tool.idempotency.keyArgument)로 싣는다
      actions: { [MCP_OPERATION]: { approval: tool.approval, idempotency: tool.idempotency === null ? { supported: false } : { supported: true, retention_ms: tool.idempotency.retentionMs } } },
      async send(call) {
        const failed = { status: 'failed', responseRef: null } as const;
        const request = call.request as { arguments?: unknown } | null;
        const approved = request?.arguments;
        if (approved === null || typeof approved !== 'object' || Array.isArray(approved)) return failed;
        // 보내기 직전 확인: 다시 읽어 닫혔으면 서버에 닿지 않고 실패로 끝난다
        await site.refresh();
        if (reasonOf(site, tool) !== null) return failed;
        if (checkArguments(site.schemaOf(tool.gatewayName), approved) !== null) return failed;
        // 사람이 승인한 인자 + 호스트가 넣는 멱등 키 하나. 승인된 인자가 키 이름을 이미 갖고 있으면 변조로 보고 보내지 않는다
        const args: Record<string, unknown> = { ...(approved as Record<string, unknown>) };
        if (tool.idempotency !== null) {
          if (Object.hasOwn(args, tool.idempotency.keyArgument)) return failed;
          args[tool.idempotency.keyArgument] = call.effectKey;
        }
        if (!(await site.acquireForSend(manifest.timeoutMs))) return failed;
        let outcome;
        try {
          outcome = await site.call(tool.name, args, { timeoutMs: manifest.timeoutMs });
        } catch (error) {
          if (error instanceof McpTransportError && error.definite) return failed; // 커넥터에 닿지 못했다
          throw error; // 시간 초과·커넥터 종료: 서버에 닿았는지 알 수 없다 → 원장이 unknown 으로 기록한다 (자동 재전송 없음)
        }
        if (!outcome.ok) {
          if (outcome.error.definite) return failed;
          throw new Error(`mcp ${tool.gatewayName}: ${outcome.error.code}`);
        }
        if (outcome.result.is_error) return failed; // 서버가 실패했다고 말했다 (설계 C7)
        return { status: 'confirmed', responseRef: `mcp:${manifest.site}:${sha256Hex(canonicalJson(outcome.result)).slice(0, 16)}` };
      },
    };
  }
  return out;
}
