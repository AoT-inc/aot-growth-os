// 열거형 상수(entities/enums.ts)가 schema.sql 의 CHECK 목록과 같은지 확인한다 (양방향).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ABORT_REASONS, ACTOR_KINDS, APPROVAL_DECISIONS, APPROVAL_SUBJECT_KINDS, CATCH_UP_MODES, CHANGE_CLASSES,
  COST_CATEGORIES, EVAL_OUTCOMES, EVIDENCE_KINDS, EXTERNAL_EFFECT_STATES, IMPACTS, LIFECYCLES, MEMORY_KINDS,
  MEMORY_VALIDITIES, ORG_PROPOSAL_STATUSES, ORG_VERSION_STATUSES, POLICY_DECISIONS, PRODUCT_KINDS,
  PRODUCT_LIFECYCLE_STAGES, PRODUCT_REGISTRATION_STATUSES, PUBLICATION_STATUSES, SAFETY_RESULTS, SCOPES,
  SENSITIVITIES, STRATEGY_STATUSES, TASK_RUN_OUTCOMES, TASK_STATUSES, TRIGGER_KINDS, TRUST_ORIGINS,
  VERIFICATION_STATUSES, openDb,
} from '@aot/domain';

import { SCHEMA_SQL } from '../support/schema-snapshot.ts';

// [테이블, 열, 상수]
const CHECKS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ['org_version', 'status', ORG_VERSION_STATUSES],
  ['org_proposal', 'status', ORG_PROPOSAL_STATUSES],
  ['org_proposal', 'change_class', CHANGE_CLASSES],
  ['org_trial_result', 'outcome', EVAL_OUTCOMES],
  ['org_trial_result', 'abort_reason', ABORT_REASONS],
  ['org_unit', 'lifecycle', LIFECYCLES],
  ['role', 'lifecycle', LIFECYCLES],
  ['actor', 'kind', ACTOR_KINDS],
  ['product', 'kind', PRODUCT_KINDS],
  ['product', 'lifecycle_stage', PRODUCT_LIFECYCLE_STAGES],
  ['product', 'registration_status', PRODUCT_REGISTRATION_STATUSES],
  ['policy_version', 'change_class', CHANGE_CLASSES],
  ['strategy_version', 'status', STRATEGY_STATUSES],
  ['routine', 'catch_up', CATCH_UP_MODES],
  ['task', 'trigger_kind', TRIGGER_KINDS],
  ['task', 'status', TASK_STATUSES],
  ['task_run', 'outcome', TASK_RUN_OUTCOMES],
  ['external_effect', 'state', EXTERNAL_EFFECT_STATES],
  ['policy_decision', 'scope', SCOPES],
  ['policy_decision', 'impact', IMPACTS],
  ['policy_decision', 'decision', POLICY_DECISIONS],
  ['evidence', 'kind', EVIDENCE_KINDS],
  ['cost_entry', 'category', COST_CATEGORIES],
  ['approval', 'subject_kind', APPROVAL_SUBJECT_KINDS],
  ['approval', 'decision', APPROVAL_DECISIONS],
  ['evaluation', 'outcome', EVAL_OUTCOMES],
  ['evaluation', 'safety', SAFETY_RESULTS],
  ['memory_item', 'kind', MEMORY_KINDS],
  ['memory_item', 'verification_status', VERIFICATION_STATUSES],
  ['memory_item', 'validity', MEMORY_VALIDITIES],
  ['memory_item', 'sensitivity', SENSITIVITIES],
  ['memory_item', 'trust_origin', TRUST_ORIGINS],
  ['publication', 'audience', SCOPES],
  ['publication', 'status', PUBLICATION_STATUSES],
];

test('enum constants equal the CHECK (col IN (...)) lists in schema.sql', () => {
  const db = openDb({ path: ':memory:' });
  try {
    db.writeTx((tx) => tx.exec(readFileSync(SCHEMA_SQL, 'utf8')));
    for (const [table, column, expected] of CHECKS) {
      const sql = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table])?.sql;
      assert.ok(sql, `table ${table} exists`);
      const match = new RegExp(`\\b${column}\\s+IN\\s*\\(([^)]*)\\)`).exec(sql);
      assert.ok(match, `${table}.${column} has a CHECK ... IN (...) list`);
      const actual = [...match[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
      assert.deepEqual([...actual].sort(), [...expected].sort(), `${table}.${column}`);
    }
  } finally {
    db.close();
  }
});
