// 비용 원장(cost_entry, append-only) 기록과 집계, 실행 중 예산 판정 (ADR-0005 Amendment 2026-10-19, ADR-0007).
//  - 기록: `recordCost` (한 줄 추가). 쓰기는 Db.writeTx 안에서만, 시각은 주입된 Clock.
//  - 집계: task / task_run / product 단위 합계 (읽기 전용).
//  - 진행 보고: 어댑터는 누적 비용(cumulative)을 보고한다. 원장에는 이미 기록한 어댑터 보고분과의 차액만 추가하므로
//    같은 값을 다시 보고해도 두 번 세지 않고, 종료 시 최종 비용도 같은 함수로 기록한다.
//  - 예산 초과 판정은 순수 함수(`evaluateBudget`)다. 실제 실행 취소는 A5 의 몫이므로 여기서는 "초과 여부 + 사유"까지 돌려준다.
import { randomUUID } from 'node:crypto';

import { COST_CATEGORIES, type Clock, type CostCategory, type CostEntryRow, type Db, type TaskRow, type TaskRunRow, type TaskSpec } from '@aot/domain';

export class CostRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostRecordError';
  }
}

/** units 의 알려진 키. 그 밖의 키는 보존만 한다 */
export interface CostUnits {
  tokens?: number;
  minutes?: number;
  /** 어댑터가 보고한 누적 비용 기록이면 'adapter' (진행 보고의 차액 계산에 쓴다) */
  source?: string;
  [key: string]: unknown;
}

export interface CostInput {
  taskId: string | null;
  taskRunId: string | null;
  /** 생략하면 업무의 product_id */
  productId?: string | null;
  category: CostCategory;
  amountUsd: number;
  units?: CostUnits | null;
}

const round = (value: number): number => Math.round(value * 1e9) / 1e9;

/** 원장에 한 줄을 더한다 (수정·삭제 불가는 트리거가 강제). 반드시 Db.writeTx 안에서 부른다. */
export function recordCost(tx: Db, clock: Clock, input: CostInput, newId: () => string = () => `cost-${randomUUID()}`): CostEntryRow {
  if (!(COST_CATEGORIES as readonly string[]).includes(input.category)) throw new CostRecordError(`unknown cost category '${String(input.category)}'`);
  if (!Number.isFinite(input.amountUsd) || input.amountUsd < 0) throw new CostRecordError('amount_usd must be a finite, non-negative number');
  if (input.taskId === null && input.taskRunId === null && input.productId === undefined) {
    throw new CostRecordError('a cost entry needs a task, a task run or a product');
  }
  let productId = input.productId ?? null;
  if (input.taskRunId !== null) {
    const run = tx.get<Pick<TaskRunRow, 'task_id'>>('SELECT task_id FROM task_run WHERE id = ?', [input.taskRunId]);
    if (!run) throw new CostRecordError(`task_run '${input.taskRunId}' does not exist`);
    if (input.taskId !== null && run.task_id !== input.taskId) throw new CostRecordError(`task_run '${input.taskRunId}' belongs to another task`);
  }
  if (input.taskId !== null && input.productId === undefined) {
    const task = tx.get<Pick<TaskRow, 'product_id'>>('SELECT product_id FROM task WHERE id = ?', [input.taskId]);
    if (!task) throw new CostRecordError(`task '${input.taskId}' does not exist`);
    productId = task.product_id;
  }
  const id = newId();
  tx.run(
    'INSERT INTO cost_entry (id, task_id, task_run_id, product_id, category, amount_usd, units, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.taskId, input.taskRunId, productId, input.category, input.amountUsd, input.units === undefined || input.units === null ? null : JSON.stringify(input.units), clock.nowIso()],
  );
  return tx.get<CostEntryRow>('SELECT * FROM cost_entry WHERE id = ?', [id])!;
}

// ===== 집계 =====

export interface CostSummary {
  entries: number;
  totalUsd: number;
  byCategory: Record<CostCategory, number>;
  tokens: number;
  /** category 'human_time' 의 units.minutes 합 */
  humanMinutes: number;
}

export function parseUnits(units: string | null): CostUnits {
  if (units === null) return {};
  try {
    const parsed: unknown = JSON.parse(units);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as CostUnits) : {};
  } catch {
    return {};
  }
}

const finiteNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** 순수 합산. 부동소수 오차를 줄이려고 1e-9 단위로 반올림한다 */
export function summarizeCosts(rows: readonly Pick<CostEntryRow, 'category' | 'amount_usd' | 'units'>[]): CostSummary {
  const byCategory = Object.fromEntries(COST_CATEGORIES.map((category) => [category, 0])) as Record<CostCategory, number>;
  let total = 0;
  let tokens = 0;
  let minutes = 0;
  for (const row of rows) {
    const amount = Number(row.amount_usd);
    total += amount;
    byCategory[row.category] += amount;
    const units = parseUnits(row.units);
    tokens += finiteNumber(units.tokens);
    if (row.category === 'human_time') minutes += finiteNumber(units.minutes);
  }
  for (const category of COST_CATEGORIES) byCategory[category] = round(byCategory[category]);
  return { entries: rows.length, totalUsd: round(total), byCategory, tokens, humanMinutes: minutes };
}

const COST_COLUMNS = 'category, amount_usd, units';

/** 업무 하나의 비용 (모든 실행 시도와 검증 단계 포함) */
export function costForTask(db: Db, taskId: string): CostSummary {
  return summarizeCosts(db.all<CostEntryRow>(`SELECT ${COST_COLUMNS} FROM cost_entry WHERE task_id = ? ORDER BY at, id`, [taskId]));
}

/** 실행(task_run) 하나의 비용. 실행 비용과 검증 비용은 같은 run 에 기록된다 (units.source 로 구분) */
export function costForRun(db: Db, taskRunId: string): CostSummary {
  return summarizeCosts(db.all<CostEntryRow>(`SELECT ${COST_COLUMNS} FROM cost_entry WHERE task_run_id = ? ORDER BY at, id`, [taskRunId]));
}

export interface CostRange {
  /** 이 시각 이상 */
  from?: string;
  /** 이 시각 미만 */
  until?: string;
}

/** 상품 단위 비용. 기간을 주면 그 구간만 */
export function costForProduct(db: Db, productId: string, range: CostRange = {}): CostSummary {
  const where = ['product_id = ?'];
  const params: string[] = [productId];
  if (range.from !== undefined) { where.push('at >= ?'); params.push(range.from); }
  if (range.until !== undefined) { where.push('at < ?'); params.push(range.until); }
  return summarizeCosts(db.all<CostEntryRow>(`SELECT ${COST_COLUMNS} FROM cost_entry WHERE ${where.join(' AND ')} ORDER BY at, id`, params));
}

// ===== 예산 판정 (순수) =====

export interface BudgetLimits {
  maxUsd: number;
  maxTokens?: number | undefined;
}

export type CancelReason = 'budget_usd_exceeded' | 'budget_tokens_exceeded';

/** 실행을 멈추라는 신호의 내용. 실제 취소 실행은 A5(agent-runtime)가 한다 */
export interface CancelSignal {
  reason: CancelReason;
  detail: string;
}

/**
 * 누적 비용이 예산을 넘었는가. "넘었다"는 한도를 *초과*한 경우다(한도와 같으면 넘지 않았다).
 * USD 를 먼저 보고, 토큰 한도가 있으면 그다음에 본다.
 */
export function evaluateBudget(spent: Pick<CostSummary, 'totalUsd' | 'tokens'>, limits: BudgetLimits): CancelSignal | null {
  if (spent.totalUsd > limits.maxUsd) {
    return { reason: 'budget_usd_exceeded', detail: `spent ${spent.totalUsd} USD exceeds the budget ${limits.maxUsd} USD` };
  }
  if (limits.maxTokens !== undefined && spent.tokens > limits.maxTokens) {
    return { reason: 'budget_tokens_exceeded', detail: `used ${spent.tokens} tokens exceeds the budget ${limits.maxTokens} tokens` };
  }
  return null;
}

/** 업무의 예산 한도: USD 는 task.cost_budget_usd, 토큰은 명세의 cost_budget.max_tokens */
export function budgetLimitsOf(task: Pick<TaskRow, 'cost_budget_usd' | 'spec'>): BudgetLimits {
  const spec = JSON.parse(task.spec) as Pick<TaskSpec, 'cost_budget'>;
  return { maxUsd: Number(task.cost_budget_usd), maxTokens: spec.cost_budget.max_tokens };
}

// ===== 실행 중 비용 진행 보고 =====

export interface CostProgressReport {
  taskRunId: string;
  /** 어댑터가 보고한 이 실행의 누적 비용 (USD). 줄어들 수 없다 */
  cumulativeUsd: number;
  /** 누적 토큰 (있으면) */
  cumulativeTokens?: number;
  category?: CostCategory;
}

export interface CostProgressResult {
  /** 이번 보고로 원장에 더한 줄 (차액이 0 이면 null) */
  recorded: CostEntryRow | null;
  /** 보고 직후 업무 전체(모든 시도 포함)의 누적 비용 */
  spent: CostSummary;
  limits: BudgetLimits;
  /** 예산 초과면 취소 신호, 아니면 null */
  cancel: CancelSignal | null;
}

const ADAPTER_SOURCE = 'adapter';

/**
 * 실행 중(`cost_progress`) 또는 종료 시(`cost`) 누적 비용을 원장에 기록하고 예산 초과를 판정한다. 한 쓰기 트랜잭션.
 * 이미 기록한 어댑터 보고분과의 차액만 더한다. 실제 비용이 발생한 것이므로 run 이 이미 닫혔거나 lease 를 잃었어도 기록한다
 * (펜싱은 결과·부작용의 중복을 막기 위한 것이고, 쓴 돈은 숨기지 않는다).
 */
export function reportCostProgress(db: Db, clock: Clock, report: CostProgressReport, newId?: () => string): CostProgressResult {
  return db.writeTx((tx) => {
    const run = tx.get<Pick<TaskRunRow, 'id' | 'task_id'>>('SELECT id, task_id FROM task_run WHERE id = ?', [report.taskRunId]);
    if (!run) throw new CostRecordError(`task_run '${report.taskRunId}' does not exist`);
    if (!Number.isFinite(report.cumulativeUsd) || report.cumulativeUsd < 0) throw new CostRecordError('cumulative cost must be a finite, non-negative number');
    const category = report.category ?? 'llm';
    const earlier = tx.all<CostEntryRow>('SELECT * FROM cost_entry WHERE task_run_id = ? AND category = ?', [run.id, category])
      .filter((row) => parseUnits(row.units).source === ADAPTER_SOURCE);
    const already = summarizeCosts(earlier);
    const delta = round(report.cumulativeUsd - already.totalUsd);
    if (delta < 0) throw new CostRecordError(`cumulative cost went down: reported ${report.cumulativeUsd} USD after ${already.totalUsd} USD`);
    const tokenDelta = report.cumulativeTokens === undefined ? 0 : report.cumulativeTokens - already.tokens;
    if (tokenDelta < 0) throw new CostRecordError(`cumulative tokens went down: reported ${report.cumulativeTokens ?? 0} after ${already.tokens}`);

    const recorded = delta === 0 && tokenDelta === 0 ? null : recordCost(tx, clock, {
      taskId: run.task_id, taskRunId: run.id, category, amountUsd: delta,
      units: { source: ADAPTER_SOURCE, ...(report.cumulativeTokens === undefined ? {} : { tokens: tokenDelta }), cumulative_usd: report.cumulativeUsd },
    }, newId);
    const task = tx.get<TaskRow>('SELECT * FROM task WHERE id = ?', [run.task_id])!;
    const spent = costForTask(tx, run.task_id);
    const limits = budgetLimitsOf(task);
    return { recorded, spent, limits, cancel: evaluateBudget(spent, limits) };
  });
}
