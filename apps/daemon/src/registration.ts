// 상품 등록 검증 도구(repo_read · secret_scan · license_check)를 데몬에 연결한다 (docs/plans/registration-dogfood.md, docs/operations/registration-tools.md).
//   - 저장소 바인딩: 에이전트는 경로를 주지 못한다. 업무 명세의 도구 `target` 이 `repo:<slug>` 하나를 가리켜야 하고, 데몬이 그 슬러그의 `product_repo` 에서 경로를 읽는다.
//     상품이 `verifying` 이고 `access_scope` 가 사람 승인으로 `read` 이상일 때만 열린다(호출마다 다시 확인한다 — 회수되면 다음 호출부터 막힌다).
//   - 근거 저장: 도구 결과 본문은 근거 저장소에 쓰고 근거 행(`RunContext.recordEvidence`, lease 펜싱)을 만든다. 행 id 가 도구 결과로 돌아가 에이전트가 보고서에서 가리킨다.
//   - 평가: 같은 저장소가 평가기의 `EvidenceReader` 다.
import type { Clock, Db, TaskSpec } from '@aot/domain';
import {
  createRegistrationTools, gatewayNameOf, LICENSE_CHECK_TOOL, REPO_READ_TOOL, RepoToolError, SECRET_SCAN_TOOL,
  type RegistrationTools, type RegistrationToolsOptions, type RepoBinding, type ToolExecutor,
} from '@aot/agent-runtime';
import type { RunContext } from '@aot/task-engine';

import type { AgentOptions } from './agent-executor.ts';
import { createEvidenceStore, type EvidenceStore } from './evidence-store.ts';
import { isAbsolute } from 'node:path';

export const REGISTRATION_TOOLS: readonly string[] = [REPO_READ_TOOL, SECRET_SCAN_TOOL, LICENSE_CHECK_TOOL];

/** 명세가 가리키는 후보 저장소 슬러그: 등록 도구의 `target` 이 모두 같은 `repo:<slug>` 여야 한다 */
export function repoSlugOf(spec: Pick<TaskSpec, 'allowed_tools'>): string {
  const slugs = new Set<string>();
  for (const entry of spec.allowed_tools) {
    if (!REGISTRATION_TOOLS.includes(entry.tool)) continue;
    const target = entry.target;
    if (typeof target !== 'string' || !/^repo:[a-z0-9][a-z0-9._-]{0,63}$/.test(target)) throw new RepoToolError('repo_not_bound', `a ${entry.tool} entry needs a target like repo:<slug>`);
    slugs.add(target.slice('repo:'.length));
  }
  if (slugs.size !== 1) throw new RepoToolError('repo_not_bound', `the task must point at exactly one repository (found ${slugs.size})`);
  return [...slugs][0]!;
}

/** 슬러그의 `product_repo` 를 해석한다. 상품이 검증 중이고 읽기 접근이 승인돼야 한다 */
export function bindRepo(db: Db, slug: string): RepoBinding {
  const rows = db.all<{ local_path: string | null; access_scope: string; registration_status: string }>(
    'SELECT pr.local_path, pr.access_scope, p.registration_status FROM product_repo pr JOIN product p ON p.id = pr.product_id WHERE p.slug = ?', [slug],
  );
  if (rows.length !== 1) throw new RepoToolError('repo_not_bound', `expected exactly one repository for the product, found ${rows.length}`);
  const row = rows[0]!;
  if (row.registration_status !== 'verifying') throw new RepoToolError('repo_not_bound', `the product is '${row.registration_status}', not under verification`);
  if (row.access_scope !== 'read' && row.access_scope !== 'write_branch') throw new RepoToolError('repo_access_not_granted', 'read access to the repository has not been approved');
  if (row.local_path === null || !isAbsolute(row.local_path)) throw new RepoToolError('repo_not_bound', 'the repository has no absolute local path');
  return { slug, root: row.local_path };
}

export interface RegistrationRuntime {
  readonly store: EvidenceStore;
  readonly tools: RegistrationTools;
  /** 그 run 의 도구 실행기 */
  executorsFor(ctx: RunContext): Map<string, ToolExecutor>;
}

export function createRegistrationRuntime(options: RegistrationToolsOptions & { db: Db; clock: Clock; evidenceDir: string }): RegistrationRuntime {
  const store = createEvidenceStore({ dir: options.evidenceDir });
  const tools = createRegistrationTools(options);
  return {
    store,
    tools,
    executorsFor(ctx) {
      return tools.executorsFor({
        repo: () => bindRepo(options.db, repoSlugOf(ctx.spec)),
        evidence: {
          capture: (input) => {
            const { sha256, ref } = store.put(input.text);
            const evidenceId = ctx.recordEvidence({ kind: 'document', ref, contentHash: sha256, trustOrigin: input.trustOrigin, capturedAt: options.clock.nowIso() });
            return Promise.resolve({ evidenceId, sha256 });
          },
        },
      });
    },
  };
}

/** 에이전트 옵션에 등록 도구 선언과 run 별 실행기를 더한다. 같은 이름의 도구가 이미 있으면 거부한다 */
export function withRegistrationTools<T extends AgentOptions>(agent: T, runtime: RegistrationRuntime): T {
  const existing = agent.tools ?? [];
  for (const spec of runtime.tools.specs) {
    if (existing.some((tool) => gatewayNameOf(tool) === gatewayNameOf(spec))) throw new Error(`tool '${gatewayNameOf(spec)}' is already configured; the registration tools provide it`);
  }
  const previous = agent.runExecutors;
  return {
    ...agent,
    tools: [...existing, ...runtime.tools.specs],
    runExecutors: (context: RunContext) => new Map([...(previous?.(context) ?? []), ...runtime.executorsFor(context)]),
  };
}
