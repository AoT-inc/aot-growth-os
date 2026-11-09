// 데몬 설정(`mcp_sites`) → MCP 조립 옵션 (ADR-0018). 설정은 비밀값 자체가 아니라 비밀을 담은 *환경 변수의 이름*만 갖는다.
// 선언을 검증하고(manifest.ts), 사이트마다 비밀 환경 변수의 값을 읽는다. 값이 비어 있으면 데몬이 시작하지 않는다.
// 읽은 값은 커넥터 프로세스의 환경으로만 넘어간다(mcp.ts): 설정 줄·DB·로그·호출 기록·초안에는 실리지 않는다.
import { parseMcpSites, secretEnvNames, type McpSiteManifest } from '@aot/agent-runtime';

import type { McpOptions } from './mcp.ts';

export interface McpConfig {
  /** 오너 MCP 서버 선언 목록. 없으면 조립하지 않는다 */
  mcp_sites?: unknown;
}

/** 이 사이트의 비밀 환경 변수 값을 읽는다. 하나라도 비어 있으면 던진다 */
export function readSiteSecrets(manifest: McpSiteManifest, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of secretEnvNames(manifest)) {
    const value = env[name];
    if (value === undefined || value === '') missing.push(name);
    else out[name] = value;
  }
  if (missing.length > 0) throw new Error(`mcp_sites: site '${manifest.site}': environment variable ${missing.join(', ')} is not set`);
  return out;
}

export function mcpOptionsFromConfig(config: McpConfig, env: NodeJS.ProcessEnv = process.env): McpOptions | undefined {
  const manifests = parseMcpSites(config.mcp_sites);
  if (manifests.length === 0) return undefined;
  return { sites: manifests.map((manifest) => ({ manifest, secretEnv: readSiteSecrets(manifest, env) })) };
}
