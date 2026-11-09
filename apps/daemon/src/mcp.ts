// MCP 조립 (ADR-0018): 사이트마다 커넥터 프로세스를 관리하는 사이트 연결(@aot/agent-runtime)과 게이트웨이 도구·부작용 도구를 만난다.
// 전화(phone.ts)와 같은 모양이다: 도구 선언(toolSpecs)·워커의 부작용 도구(effectTools)·run 별 실행기(executorsFor)를 내놓고 assemble.ts 의 withMcp 가 합친다.
// 에이전트가 부르는 것은 늘 게이트웨이 도구이고, 명세 `allowed_tools`·호출별 정책 판정(`mcp_<site>_<as>.call`)·부작용 원장이 모두 그대로 적용된다.
import {
  createMcpEffectTools, createMcpSiteClient, createMcpToolExecutors, maskString, mcpToolSpecs, spawnConnectorProcess,
  type ConnectorLink, type GatewayTimers, type GatewayToolSpec, type McpEffectTool, type McpSiteClient, type McpSiteEvent, type McpSiteManifest, type ToolExecutor,
} from '@aot/agent-runtime';
import type { Clock } from '@aot/domain';
import type { RunContext } from '@aot/task-engine';

export interface McpSiteSetup {
  manifest: McpSiteManifest;
  /** 이 사이트의 비밀 환경 변수(이름 → 값). 커넥터 프로세스의 환경으로만 넘어간다 */
  secretEnv: Readonly<Record<string, string>>;
}

export interface McpOptions {
  sites: readonly McpSiteSetup[];
  /** 시험용: 커넥터 프로세스를 띄우는 방법을 바꾼다. 기본은 실제 커넥터 프로세스 */
  spawn?: (setup: McpSiteSetup) => ConnectorLink;
  timers?: GatewayTimers;
  recheckIntervalMs?: number;
  /** 운영 이벤트(도구 상태 변화, 선언 밖 도구, 서버 요청 거절, 커넥터 종료). 기본은 stderr 에 한 줄 */
  onEvent?: (event: McpSiteEvent) => void;
}

export interface McpRuntime {
  readonly sites: ReadonlyMap<string, McpSiteClient>;
  /** 오너 선언에서 나온 게이트웨이 도구 선언 (서버가 도구를 더해도 같다) */
  readonly toolSpecs: readonly GatewayToolSpec[];
  /** 워커의 `tools` 에 합쳐지는 부작용 도구 */
  readonly effectTools: Readonly<Record<string, McpEffectTool>>;
  executorsFor(context: RunContext): ReadonlyMap<string, ToolExecutor>;
  /** 커넥터 프로세스를 띄우고 첫 고정 확인을 마친다 */
  start(): Promise<void>;
  /** 커넥터 프로세스를 모두 끝낸다 */
  close(): Promise<void>;
}

export const logMcpEvent = (event: McpSiteEvent): void => {
  console.error(`mcp ${event.site}: ${maskString(JSON.stringify(event))}`);
};

export function createMcpRuntime(deps: { clock: Clock; options: McpOptions }): McpRuntime {
  const { clock, options } = deps;
  const sites = new Map<string, McpSiteClient>();
  const specs: GatewayToolSpec[] = [];
  const effectTools: Record<string, McpEffectTool> = {};
  const byManifest: { manifest: McpSiteManifest; client: McpSiteClient }[] = [];
  for (const setup of options.sites) {
    const { manifest } = setup;
    if (sites.has(manifest.site)) throw new Error(`mcp site '${manifest.site}' is configured twice`);
    const client = createMcpSiteClient({
      manifest, clock,
      spawn: () => (options.spawn === undefined ? spawnConnectorProcess(setup.secretEnv) : options.spawn(setup)),
      onEvent: options.onEvent ?? logMcpEvent,
      ...(options.timers === undefined ? {} : { timers: options.timers }),
      ...(options.recheckIntervalMs === undefined ? {} : { recheckIntervalMs: options.recheckIntervalMs }),
    });
    sites.set(manifest.site, client);
    byManifest.push({ manifest, client });
    specs.push(...mcpToolSpecs(manifest));
    Object.assign(effectTools, createMcpEffectTools(manifest, client));
  }
  return {
    sites, toolSpecs: specs, effectTools,
    executorsFor: (context) => {
      const out = new Map<string, ToolExecutor>();
      for (const { manifest, client } of byManifest) {
        for (const [name, executor] of createMcpToolExecutors(manifest, client, (tool, step, meta) => context.performEffect(tool, step, meta))) out.set(name, executor);
      }
      return out;
    },
    async start() {
      await Promise.all(byManifest.map(({ client }) => client.start()));
    },
    async close() {
      await Promise.all(byManifest.map(({ client }) => client.close()));
    },
  };
}
