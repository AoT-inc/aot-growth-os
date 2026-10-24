// 도래한 루틴 슬롯 발화 (A6-U9). TaskWorker.tick 이 옵션으로 부른다.
// 하는 일: 켜진 루틴마다 (1) schedule 해석 (2) 마지막 발화 이후 도래한 슬롯을 catch_up 으로 거른다 (schedule.ts)
// (3) RoutineTemplateSource 포트로 템플릿을 업무 명세들로 해석 (4) fireRoutineTasks 로 발화(routine_firing PK 멱등)한다.
//
// 기준점(어느 시각 *뒤*의 슬롯부터 보는가): 마지막 발화의 scheduled_for 와 활성화 시각 중 늦은 쪽. 활성화 시각은 `activatedAt` 옵션이 주면 그 값,
//   아니면 그 루틴을 켠 가장 최근 실험 활성화 event(A6-U15, domain `latestRoutineActivation`)의 occurred_at 이다 — routine 행에는 켠 시각 열이 없다.
//   그래서 실험 승인으로 켜진 루틴은 활성화 시각 *이후* 슬롯부터 발화하고, 재시작해도 기준점이 옮겨 가지 않으며, 다시 켜진 루틴은 꺼져 있던 동안의 슬롯을
//   catch_up 으로 끌어오지 않는다. 둘 다 없으면(실험 경로 밖에서 켠 루틴) "이 프로세스가 그 루틴을 처음 본 시각"이다 (그 전에 지나간 슬롯은 발화하지 않는다).
// 실험 루틴이 발화한 업무에는 그 전략(활성화 기록의 전략이 아직 `experiment` 이고 종료 기록이 없을 때)을 `task.strategy_version_id` 로 붙인다.
// 다중 프로세스: 같은 슬롯을 여러 데몬이 동시에 발화해도 routine_firing PK 와 쓰기 트랜잭션 직렬화로 한 건만 남는다.
import { experimentEnded, latestRoutineActivation, type CatchUpMode, type Db, type ExperimentActivation } from '@aot/domain';

import { fireRoutineTasks, type CreateContext, type RoutineTemplateTask } from './create.ts';
import { TaskCreationError } from './errors.ts';
import { parseSchedule, planFirings, ScheduleError, type CronSchedule } from './schedule.ts';

/** 템플릿 해석 요청에 담기는 루틴 */
export interface RoutineRef {
  id: string;
  slug: string;
  orgUnitId: string;
  productId: string | null;
  /** `routine.schedule` 원문 */
  schedule: string;
  /** `routine.task_template` 원문 (예: `weekly-research@1`) */
  taskTemplate: string;
  catchUp: CatchUpMode;
}

export interface RoutineTemplateRequest {
  routine: RoutineRef;
  /** 이번 발화의 슬롯 (UTC ISO). 템플릿 안의 날짜·주차 표기를 채울 때 쓴다 */
  scheduledFor: string;
}

/**
 * 루틴의 `task_template` 을 업무 명세 1개 이상으로 해석하는 포트. 구현은 apps(팩 로더, U10)가 한다.
 * 한 템플릿은 업무 여러 개를 낼 수 있고, 업무끼리의 선후는 템플릿 안 이름(`name`, `dependsOn`)으로 건다.
 * 반환하는 명세는 draft 다 (trigger·policy_version·versions 는 엔진이 채운다). 던지면 그 슬롯은 발화되지 않고 다음 tick 에 다시 시도한다.
 */
export interface RoutineTemplateSource {
  resolve(request: RoutineTemplateRequest): Promise<readonly RoutineTemplateTask[]> | readonly RoutineTemplateTask[];
}

export interface RoutineScheduleOptions {
  source: RoutineTemplateSource;
  /** 늦지 않은 슬롯의 허용 지연. 이보다 오래된 미발화 슬롯은 "놓친" 것이다. 기본 10분 (긴 업무 실행 중에 도래한 슬롯을 잃지 않을 만큼) */
  lateToleranceMs?: number;
  /** 루틴의 활성화 시각(UTC ISO). 주지 않거나 null 이면 실험 활성화 event 의 시각, 그것도 없으면 이 프로세스가 처음 본 시각 */
  activatedAt?: (routine: RoutineRef) => string | null;
}

export const DEFAULT_LATE_TOLERANCE_MS = 10 * 60_000;

export interface RoutineFired {
  routineId: string;
  slug: string;
  scheduledFor: string;
  /** false 면 다른 데몬이 먼저 발화했다 */
  created: boolean;
  taskIds: string[];
}

export interface RoutineFailure {
  routineId: string;
  /** 일정 자체가 잘못되었으면 null */
  scheduledFor: string | null;
  error: string;
}

export interface RoutineTickReport {
  fired: RoutineFired[];
  failed: RoutineFailure[];
}

type RoutineRow = {
  id: string; slug: string; org_unit_id: string; product_id: string | null; schedule: string; task_template: string; catch_up: CatchUpMode;
};

/** 루틴 발화기. 프로세스 안 상태(처음 본 시각, 이미 거부된 슬롯)만 가진다 — 나머지는 전부 DB 에 있다. */
export class RoutineFirer {
  readonly #options: RoutineScheduleOptions;
  readonly #firstSeenMs = new Map<string, number>();
  /** 결정적으로 거부된 (잘못된 일정, 정책·참조 거부) 슬롯은 이 프로세스에서 다시 시도하지 않는다 — 거부 기록이 tick 마다 쌓이지 않게 */
  readonly #rejected = new Set<string>();
  readonly #schedules = new Map<string, CronSchedule>();

  constructor(options: RoutineScheduleOptions) {
    this.#options = options;
  }

  async fireDue(db: Db, context: CreateContext): Promise<RoutineTickReport> {
    const nowMs = context.clock.nowMs();
    const report: RoutineTickReport = { fired: [], failed: [] };
    const routines = db.all<RoutineRow>(
      'SELECT id, slug, org_unit_id, product_id, schedule, task_template, catch_up FROM routine WHERE enabled = 1 ORDER BY slug, id',
    );
    for (const row of routines) {
      const routine: RoutineRef = {
        id: row.id, slug: row.slug, orgUnitId: row.org_unit_id, productId: row.product_id, schedule: row.schedule,
        taskTemplate: row.task_template, catchUp: row.catch_up,
      };
      const schedule = this.#scheduleOf(routine, report);
      if (!schedule) continue;
      const activation = latestRoutineActivation(db, routine.id);
      const slots = planFirings({
        schedule, catchUp: routine.catchUp, afterMs: this.#anchorMs(db, routine, activation, nowMs), nowMs,
        lateToleranceMs: this.#options.lateToleranceMs ?? DEFAULT_LATE_TOLERANCE_MS,
      });
      const strategyVersionId = activation === null ? null : experimentOf(db, activation);
      for (const scheduledFor of slots) await this.#fire(db, context, routine, scheduledFor, strategyVersionId, report);
    }
    return report;
  }

  #scheduleOf(routine: RoutineRef, report: RoutineTickReport): CronSchedule | null {
    const key = `${routine.id}|${routine.schedule}`;
    const known = this.#schedules.get(key);
    if (known) return known;
    if (this.#rejected.has(`${key}|invalid`)) return null;
    try {
      const parsed = parseSchedule(routine.schedule);
      this.#schedules.set(key, parsed);
      return parsed;
    } catch (error) {
      if (!(error instanceof ScheduleError)) throw error;
      this.#rejected.add(`${key}|invalid`);
      report.failed.push({ routineId: routine.id, scheduledFor: null, error: error.message });
      return null;
    }
  }

  #anchorMs(db: Db, routine: RoutineRef, activation: ExperimentActivation | null, nowMs: number): number {
    const last = db.get<{ last: string | null }>('SELECT max(scheduled_for) AS last FROM routine_firing WHERE routine_id = ?', [routine.id])?.last ?? null;
    const activated = this.#options.activatedAt?.(routine) ?? activation?.activatedAt ?? null;
    const known = [last, activated].filter((value): value is string => value !== null).map((value) => Date.parse(value));
    if (known.length > 0) return Math.max(...known);
    let seen = this.#firstSeenMs.get(routine.id);
    if (seen === undefined) {
      seen = nowMs;
      this.#firstSeenMs.set(routine.id, seen);
    }
    return seen;
  }

  async #fire(db: Db, context: CreateContext, routine: RoutineRef, scheduledFor: string, strategyVersionId: string | null, report: RoutineTickReport): Promise<void> {
    const key = `${routine.id}@${scheduledFor}`;
    if (this.#rejected.has(key)) return;
    try {
      const tasks = await this.#options.source.resolve({ routine, scheduledFor });
      const result = fireRoutineTasks(db, context, { routineId: routine.id, scheduledFor, strategyVersionId }, tasks);
      report.fired.push({ routineId: routine.id, slug: routine.slug, scheduledFor, created: result.created, taskIds: result.taskIds });
    } catch (error) {
      if (error instanceof TaskCreationError) this.#rejected.add(key);
      report.failed.push({ routineId: routine.id, scheduledFor, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** 활성화 기록의 전략이 아직 진행 중인 실험이면 그 id (업무에 붙인다), 아니면 null */
function experimentOf(db: Db, activation: ExperimentActivation): string | null {
  const row = db.get<{ status: string }>('SELECT status FROM strategy_version WHERE id = ?', [activation.strategyVersionId]);
  return row?.status === 'experiment' && !experimentEnded(db, activation.strategyVersionId) ? activation.strategyVersionId : null;
}
