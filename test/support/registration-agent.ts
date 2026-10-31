// 상품 등록 검증 시험이 함께 쓰는 것: 후보 저장소 파일과, 게이트웨이로 도구 7개를 불러 registration-report@1 을 내는 시험용 에이전트 어댑터.
import type { AdapterContext, AdapterOutput, AgentAdapter, JsonObject, ToolGatewayResponse } from '@aot/agent-runtime';
import { registrationToolName } from '@aot/agent-runtime';

import type { RepoFiles } from './registration-tools.ts';

export const REGISTRATION_FILES: RepoFiles = {
  'README.md': '# example-product\nA small command line tool.\n',
  'package.json': JSON.stringify({ name: 'example-product', license: 'MIT' }),
  'src/index.ts': 'export const x = 1;\n',
  'LICENSE': 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.\nTHE SOFTWARE IS PROVIDED "AS IS".\n',
};

export interface CallRecord { name: string; ok: boolean; error?: string }

/** 에이전트 역할의 어댑터: 게이트웨이로 도구를 불러 근거 id 를 모으고, 그 id 를 인용한 registration-report@1 을 낸다 */
export function scriptedAgent(calls: CallRecord[]): AgentAdapter {
  return {
    name: 'scripted-agent',
    async run(_input, context: AdapterContext): Promise<AdapterOutput> {
      const call = async (tool: string, operation: string, args: JsonObject = {}): Promise<JsonObject | null> => {
        const name = registrationToolName(tool, operation);
        const response: ToolGatewayResponse = await context.gateway.call(name, args);
        calls.push({ name, ok: response.ok, ...(response.ok ? {} : { error: response.error }) });
        return response.ok ? (response.result as JsonObject) : null;
      };
      const tree = await call('repo_read', 'list_tree', { depth: 2 });
      const readme = await call('repo_read', 'read_file', { path: 'README.md' });
      const meta = await call('repo_read', 'read_metadata');
      const history = await call('repo_read', 'read_history');
      const scanTree = await call('secret_scan', 'scan_tree');
      const scanHistory = await call('secret_scan', 'scan_history');
      const license = await call('license_check', 'identify');
      if ([tree, readme, meta, history, scanTree, scanHistory, license].some((result) => result === null)) {
        return { status: 'error', result: null, evidence: [], run_log: [], cost: { tokens: 0 }, error: { code: 'tool_failed', message: 'a tool call was refused' } };
      }
      const id = (result: JsonObject | null): string => String(result!['evidence_id']);
      const collected = (item: string, ...ids: string[]) => ({ item, status: 'collected', evidence_ids: ids });
      const report = {
        claims: [{ id: 'c1', statement: 'The README describes a small command line tool.', evidence_id: id(readme) }],
        collection: [
          collected('repo_structure', id(tree)), collected('stack', id(meta)), collected('readme_summary', id(readme)),
          { item: 'remote', status: 'unavailable', reason: 'the repository has no remote configured' },
          collected('default_branch', id(meta)), collected('activity_history', id(history)), collected('license', id(license)),
          { item: 'environment', status: 'unavailable', reason: 'no environment names appear in the documentation' },
          collected('secret_scan', id(scanTree), id(scanHistory)),
        ],
        classification: { proposal: 'internal', rationale_evidence_ids: [id(license)] },
        uncertainties: [],
      };
      // 실제 모델은 보고서에서 인용한 호스트 근거를 구조화 출력의 `evidence` 에도 다시 적는다(파일럿에서 관찰). 인용 항목이 증거 행이 되지 않아야 한다
      const capturedAt = new Date().toISOString();
      const citations = [tree, readme, meta, history, scanTree, scanHistory, license].map((result) => ({ kind: 'document' as const, ref: id(result), trust_origin: 'external_untrusted' as const, captured_at: capturedAt }));
      return { status: 'submitted', result: report as unknown as JsonObject, evidence: citations, run_log: [], cost: { tokens: 100 } };
    },
  };
}

