// 승인 대기 목록·상세. 해시와 판정은 승인 엔진의 `list`·`show` (읽기 전용 명령)를 그대로 쓴다 — 승인 CLI 가 보여 주는 값과 같다.
import { getOrgProposal } from '@aot/domain';

import type { ReviewContext } from './context.ts';
import { APPROVE_CLI, back, badge, command, h, kv, link, list, shellArg, table, type Raw } from './html.ts';
import { json, orgApprovalCommands, orgHeadline, orgProposalSummary } from './pages-org.ts';

export type ApprovalKind = 'task' | 'publication' | 'policy_version' | 'strategy_version' | 'org_proposal';
export const APPROVAL_KINDS: readonly ApprovalKind[] = ['task', 'publication', 'policy_version', 'strategy_version', 'org_proposal'];
/** 승인 CLI 가 받는 별칭 */
const CLI_KIND: Readonly<Record<ApprovalKind, string>> = { task: 'task', publication: 'publication', policy_version: 'policy', strategy_version: 'strategy', org_proposal: 'org' };
export const KIND_LABEL: Readonly<Record<ApprovalKind, string>> = {
  task: '업무 (검토 필요)', publication: '게시', policy_version: '정책 제안', strategy_version: '실험 전략 제안', org_proposal: '조직 변경 제안',
};

export interface PendingLists {
  tasks: { id: string; objective: string; reason: string | null }[];
  publications: { id: string; audience: string; status: string }[];
  policy_proposals: string[];
  strategy_proposals: { id: string; title: string; created_at: string }[];
  strategy_reviews: { planning_task_id: string; outcome: string; reasons: string[]; recorded_at: string }[];
  experiments: { id: string; activated_at: string | null }[];
  org_proposals: { id: string; change_class: string; created_at: string }[];
}

const EMPTY: PendingLists = { tasks: [], publications: [], policy_proposals: [], strategy_proposals: [], strategy_reviews: [], experiments: [], org_proposals: [] };

/** 승인 엔진 `list`. 사람 행위자가 없거나 거부되면 비어 있고 이유를 돌려준다 */
export function pendingLists(ctx: ReviewContext): { lists: PendingLists; problem: string | null } {
  if (ctx.actor === null) return { lists: EMPTY, problem: '이 DB 에 사람(human) 행위자가 없어 승인 대기 목록을 읽을 수 없다.' };
  const response = ctx.engine.handle({ cmd: 'list', actor: ctx.actor });
  if (!response.ok) return { lists: EMPTY, problem: `승인 대기 목록을 읽지 못했다: ${String(response.error)}` };
  return { lists: { ...EMPTY, ...(response as unknown as Partial<PendingLists>) }, problem: null };
}

const detailLink = (kind: ApprovalKind, id: string): Raw => link(['approvals', kind, id], id);

export function approvalsPage(ctx: ReviewContext): Raw {
  const { lists, problem } = pendingLists(ctx);
  const orgRows = lists.org_proposals.map((entry) => {
    const row = getOrgProposal(ctx.db, entry.id);
    return [detailLink('org_proposal', entry.id), row === undefined ? '-' : orgHeadline(row), badge(entry.change_class === 'risky' ? '위험 변경' : '일반 변경', entry.change_class === 'risky' ? 'bad' : 'ok'), entry.created_at];
  });
  return h`${problem === null ? '' : h`<p class="card">${problem}</p>`}
    <h2>${KIND_LABEL.org_proposal} (${lists.org_proposals.length})</h2>${table(['제안', '내용', '등급', '만든 시각'], orgRows)}
    <h2>${KIND_LABEL.task} (${lists.tasks.length})</h2>${table(['업무', '목표', '마지막 전이 사유'], lists.tasks.map((t) => [detailLink('task', t.id), t.objective, t.reason ?? '-']))}
    <h2>${KIND_LABEL.publication} (${lists.publications.length})</h2>${table(['게시', '대상', '상태'], lists.publications.map((p) => [detailLink('publication', p.id), p.audience, p.status]))}
    <h2>${KIND_LABEL.policy_version} (${lists.policy_proposals.length})</h2>${table(['제안'], lists.policy_proposals.map((id) => [detailLink('policy_version', id)]))}
    <h2>${KIND_LABEL.strategy_version} (${lists.strategy_proposals.length})</h2>${table(['제안', '제목', '만든 시각'], lists.strategy_proposals.map((s) => [detailLink('strategy_version', s.id), s.title, s.created_at]))}
    <h2>추천 없이 끝난 비교 기록 (${lists.strategy_reviews.length})</h2><p class="mute">사람이 읽고 다음 기획을 정한다. 승인할 대상이 아니다.</p>
    ${table(['기획 업무', '결과', '이유', '기록 시각'], lists.strategy_reviews.map((r) => [r.planning_task_id, r.outcome, r.reasons.join(' / '), r.recorded_at]))}
    <h2>진행 중인 실험 (${lists.experiments.length})</h2>${table(['전략', '활성화'], lists.experiments.map((e) => [e.id, e.activated_at ?? '아직']))}`;
}

type Shown = Record<string, unknown>;
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

function commandsFor(kind: ApprovalKind, id: string, shown: Shown): Raw {
  const approval = obj(shown['approval']);
  const state = typeof approval['state'] === 'string' ? approval['state'] : null;
  const hash = typeof shown['hash'] === 'string' ? shown['hash'] : null;
  const alias = CLI_KIND[kind];
  const status = String(shown['status'] ?? '');
  if (kind === 'org_proposal') return orgApprovalCommands(id, hash, status, state, shown['change_class'] === 'risky');
  const out: Raw[] = [];
  if (state === 'cooldown') {
    out.push(h`<p>승인은 기록됐고 대기 시간 중이다 (${String(approval['cooldown_ends_at'] ?? '')} 까지). 대기 중에는 취소할 수 있다.</p>`, command(`${APPROVE_CLI} cancel ${alias} ${shellArg(id)} --comment "사유"`, '대기 중 취소'));
  } else if (state === 'reauth_required') {
    out.push(h`<p>대기가 끝났다. TOTP 재인증으로 해제한다 (코드는 표준 입력으로).</p>`, command(`${APPROVE_CLI} release ${alias} ${shellArg(id)} --totp-stdin`, '해제'), command(`${APPROVE_CLI} cancel ${alias} ${shellArg(id)} --comment "사유"`, '취소'));
  } else if (kind === 'policy_version') {
    out.push(h`<p class="mute">정책 배포 승인은 정책 파일을 직접 지정해 한다.</p>`, command(`${APPROVE_CLI} approve policy --file <정책.yaml>`, '배포 승인'), command(`${APPROVE_CLI} release policy ${shellArg(id)} --totp-stdin`, '대기 뒤 해제 (위험 변경)'), command(`${APPROVE_CLI} cancel policy ${shellArg(id)} --comment "사유"`, '취소'));
  } else {
    out.push(command(`${APPROVE_CLI} approve ${alias} ${shellArg(id)} --hash ${hash === null ? '<해시를 확인할 수 없다>' : shellArg(hash)} --comment "사유"`, '승인'), command(`${APPROVE_CLI} reject ${alias} ${shellArg(id)} --comment "사유"`, '거절'));
  }
  return h`${out}`;
}

function taskDetail(ctx: ReviewContext, id: string, shown: Shown): Raw {
  const task = ctx.db.get<{ objective: string; status: string; created_at: string; attempts: number; max_attempts: number; cost_budget_usd: number }>(
    'SELECT objective, status, created_at, attempts, max_attempts, cost_budget_usd FROM task WHERE id = ?', [id],
  );
  const reason = ctx.db.get<{ reason: string | null; at: string }>('SELECT reason, at FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [id]);
  const spec = obj(obj(shown['subject'])['spec']);
  const tools = Array.isArray(spec['allowed_tools']) ? (spec['allowed_tools'] as unknown[]) : [];
  const decisions = Array.isArray(shown['decisions']) ? (shown['decisions'] as Record<string, unknown>[]) : [];
  return h`<div class="card">${kv([
    ['목표', task?.objective ?? '-'], ['상태', task?.status ?? '-'], ['시도', task === undefined ? '-' : `${task.attempts} / ${task.max_attempts}`], ['비용 한도(USD)', task?.cost_budget_usd ?? '-'],
    ['검토가 필요한 이유', reason?.reason ?? '-'], ['만든 시각', task?.created_at ?? '-'],
  ])}</div>
    <div class="card"><h2>요청한 도구</h2>${table(['도구', '작업', '범위', '영향', '대상'], tools.map((raw) => {
    const tool = obj(raw);
    return [tool['tool'], Array.isArray(tool['operations']) ? tool['operations'].join(', ') : '', tool['scope'], tool['impact'], tool['target'] ?? '-'];
  }))}</div>
    <div class="card"><h2>정책 판정</h2>${table(['작업', '자원', '범위', '영향', '판정', '이유'], decisions.map((d) => [d['action'], d['resource'], d['scope'], d['impact'], d['decision'], d['reason']]))}</div>`;
}

export function approvalDetailPage(ctx: ReviewContext, kind: ApprovalKind, id: string): { title: string; body: Raw; status: number } {
  const title = `${KIND_LABEL[kind]} 상세`;
  const missing = (message: string, status = 404) => ({ title, status, body: h`${back('/approvals', '승인 대기 목록')}<p class="card">${message}</p>` });
  if (ctx.actor === null) return missing('이 DB 에 사람(human) 행위자가 없어 조회할 수 없다.', 503);
  const response = ctx.engine.handle({ cmd: 'show', actor: ctx.actor, kind, id });
  if (!response.ok) return missing(`조회하지 못했다: ${String(response.error)}`);
  const shown = response as unknown as Shown;
  const approval = obj(shown['approval']);
  const head = h`${back('/approvals', '승인 대기 목록')}<p>${badge(KIND_LABEL[kind], 'info')} <code>${id}</code> ${badge(String(shown['status'] ?? '-'), 'mute')}
    ${approval['state'] === undefined ? '' : h`<span class="mute">승인 단계: ${String(approval['state'])} — ${String(approval['reason'] ?? '')}</span>`}</p>`;
  let detail: Raw;
  if (kind === 'org_proposal') {
    const row = getOrgProposal(ctx.db, id);
    detail = row === undefined ? h`<p class="empty">제안을 찾을 수 없다</p>` : orgProposalSummary(ctx, row);
  } else if (kind === 'task') {
    detail = taskDetail(ctx, id, shown);
  } else if (kind === 'publication') {
    const subject = obj(shown['subject']);
    detail = h`<div class="card">${kv([['채널', subject['channel']], ['대상 독자', subject['audience']], ['내용 위치', subject['content_ref']], ['업무', subject['task_id']]])}</div>`;
  } else if (kind === 'strategy_version') {
    const row = ctx.db.get<{ title: string; body: string; experiment_scope: string | null; created_at: string; created_by: string }>('SELECT title, body, experiment_scope, created_at, created_by FROM strategy_version WHERE id = ?', [id]);
    const scope = row?.experiment_scope == null ? null : json(row.experiment_scope);
    detail = h`<div class="card"><h2>${row?.title ?? '-'}</h2><p>${row?.body ?? ''}</p>${kv([['제안자', row?.created_by ?? '-'], ['만든 시각', row?.created_at ?? '-'], ['진행 중인 다른 실험', list(Array.isArray(shown['experiments_in_progress']) ? (shown['experiments_in_progress'] as unknown[]) : [], '없음')]])}</div>
      <div class="card"><h2>실험 범위</h2>${scope === null ? h`<p class="empty">없음</p>` : h`<pre>${JSON.stringify(scope, null, 2)}</pre>`}</div>`;
  } else {
    detail = h`<div class="card">${kv([['변경 등급', shown['change_class']], ['사유', Array.isArray(shown['reasons']) ? (shown['reasons'] as unknown[]).join(' / ') : '-']])}</div>`;
  }
  return { title, status: 200, body: h`${head}${detail}<div class="card"><h2>결정하려면 (승인 CLI)</h2>${commandsFor(kind, id, shown)}</div>` };
}
