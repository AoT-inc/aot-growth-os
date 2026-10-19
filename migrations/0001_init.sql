-- AoT Growth OS — 스키마 v0 (설계 기준, 단일 원천)
-- migrations/0001_init.sql 은 이 파일의 복사본이다. 첫 공개 릴리스 전까지는(배포된 DB 없음) 0001 을 이 파일과 함께 직접 고치고,
-- 첫 릴리스 이후에는 새 마이그레이션과 이 파일을 동시에 고친다
-- (드리프트 시험: test/unit/schema-drift.test.ts, 결정 기록: docs/plans/phase-a.md §4 A0 "마이그레이션" 항목).
-- SQLite로 시작, Postgres 이식 가능한 범위(JSON은 TEXT, 시간은 ISO8601 UTC TEXT).
-- 규칙: 변경 이력이 중요한 테이블은 append-only(UPDATE/DELETE 금지)로 다룬다.

-- ===== 조직 / 행위자 =====
-- 조직 버전 (ADR-0011): 조직 변경 확정마다 1건. 업무가 생성 시점 버전을 기록한다.
CREATE TABLE org_version (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT REFERENCES org_version(id),
  proposal_id  TEXT,                          -- org_proposal.id (순환 참조 회피를 위해 FK 생략)
  snapshot     TEXT NOT NULL,                 -- JSON: 당시 org_unit/role 구성
  status       TEXT NOT NULL CHECK (status IN ('trial','active','retired','rolled_back')),
  created_at   TEXT NOT NULL
);

CREATE TABLE org_proposal (
  id           TEXT PRIMARY KEY,
  proposed_by  TEXT NOT NULL,                 -- actor id (보통 org-management 역할)
  diff         TEXT NOT NULL,                 -- JSON: 추가/변경/폐지 대상
  rationale    TEXT NOT NULL,
  evidence_refs TEXT NOT NULL,                -- JSON: evaluation/task 통계/memory 참조
  expected_effect TEXT NOT NULL,
  base_org_version_id TEXT NOT NULL REFERENCES org_version(id),  -- 제안 기준 버전 (충돌 검사)
  proposal_hash TEXT NOT NULL,                -- diff+기준 버전의 해시
  scope        TEXT NOT NULL,                 -- JSON: 영향 받는 역할·업무 유형
  risk_assessment TEXT NOT NULL,              -- JSON: 위험과 완화책
  evaluation_plan TEXT NOT NULL,              -- JSON: success/fail/abort 기준, min_observations, 데이터 품질 조건, 비교 기준선, 허용 비용, 평가 기간
  rollback_plan TEXT NOT NULL,                -- JSON: 조직 버전 복구 + 예약/진행 중 업무 처리 + 외부 부작용 처리
  change_class TEXT NOT NULL CHECK (change_class IN ('normal','risky')),
  trial_scope  TEXT NOT NULL,                 -- JSON: 시험 기간 영향 업무 유형
  trial_min_days INTEGER NOT NULL DEFAULT 14,
  trial_extensions INTEGER NOT NULL DEFAULT 0,  -- 연장은 자동 허용하지 않음. 별도 승인 필요
  expires_at   TEXT NOT NULL,                 -- 승인 전 제안 만료
  status       TEXT NOT NULL CHECK (status IN
                 ('proposed','rejected','approved','trial','active','inconclusive','rolled_back','retired','expired','superseded')),
  org_version_id TEXT REFERENCES org_version(id),
  created_at   TEXT NOT NULL
);

-- 시험 평가 결과. pass / fail / inconclusive (ADR-0011, operations/evaluation.md)
CREATE TABLE org_trial_result (
  id           TEXT PRIMARY KEY,
  proposal_id  TEXT NOT NULL REFERENCES org_proposal(id),
  evaluator    TEXT NOT NULL,                 -- 평가기 id@version (조직 관리팀이 아님)
  outcome      TEXT NOT NULL CHECK (outcome IN ('pass','fail','inconclusive')),
  abort_reason TEXT CHECK (abort_reason IN ('safety','budget','quality')),  -- 즉시 중단 시
  observations INTEGER NOT NULL,              -- 실제 관측(업무) 수
  metrics      TEXT NOT NULL,                 -- JSON: 시험 vs 기준선 비교
  evidence_refs TEXT NOT NULL,                -- JSON: 원본 증거 참조
  at           TEXT NOT NULL
);

CREATE TABLE org_unit (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT REFERENCES org_unit(id),
  slug         TEXT NOT NULL UNIQUE,          -- 시작 시 org-management 등 최소 구성. 나머지는 org_proposal로 생성
  lifecycle    TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('proposed','trial','active','retired')),
  name         TEXT NOT NULL,
  responsibility TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE role (
  id           TEXT PRIMARY KEY,
  org_unit_id  TEXT NOT NULL REFERENCES org_unit(id),
  slug         TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL,
  allowed_tools TEXT NOT NULL,                -- JSON: 역할 요청 도구 (정책이 최종 결정, 역할 생성만으로 권한 없음)
  lifecycle    TEXT NOT NULL DEFAULT 'proposed' CHECK (lifecycle IN ('proposed','trial','active','retired')),
  version      INTEGER NOT NULL DEFAULT 1,
  trial_scope  TEXT,                          -- JSON: trial 역할이 받을 수 있는 업무 유형
  created_at   TEXT NOT NULL
);

CREATE TABLE actor (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('human','agent')),
  name         TEXT NOT NULL,
  adapter      TEXT,                          -- kind='agent'일 때 agent_adapter 식별자
  created_at   TEXT NOT NULL
);

CREATE TABLE role_assignment (
  actor_id     TEXT NOT NULL REFERENCES actor(id),
  role_id      TEXT NOT NULL REFERENCES role(id),
  valid_from   TEXT NOT NULL,
  valid_until  TEXT,
  PRIMARY KEY (actor_id, role_id, valid_from)
);

-- ===== 개발 상품 (ADR-0010) =====
CREATE TABLE product (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,       -- 예: example-product (실제 제품명은 내부 DB에만)
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('software','physical','service','other')),  -- 업종 중립 (ADR-0012 §5)
  description     TEXT,
  lifecycle_stage TEXT NOT NULL CHECK (lifecycle_stage IN
                    ('idea','development','beta','live','maintenance','sunset')),
  owner_org_unit_id TEXT REFERENCES org_unit(id),
  registration_status TEXT NOT NULL DEFAULT 'candidate' CHECK (registration_status IN
                    ('candidate','verifying','pending_approval','registered','rejected')),
  registration_approval_id TEXT,              -- approval.id (subject_kind='product'. registered 필수, 애플리케이션 규칙)
  registered_at   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- 등록 검증 업무가 수집한 사실은 evidence로 저장하고, 승인 시 아래 컬럼에 반영한다.
-- registered가 아닌 product는 task/event/... 의 product_id가 가리킬 수 없다 (애플리케이션 규칙).
-- 저장소는 선택이다: product 하나가 0..N개의 product_repo를 가진다 (ADR-0012 §5). 소프트웨어가 아닌 상품은 0개.
CREATE TABLE product_repo (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL REFERENCES product(id),
  name         TEXT NOT NULL,
  local_path   TEXT,
  remote_url   TEXT,
  default_branch TEXT,
  stack        TEXT,                          -- JSON (확인 전에는 null)
  access_scope TEXT NOT NULL DEFAULT 'none'   -- none | read | write_branch (정책이 최종 결정)
);

CREATE TABLE product_environment (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL REFERENCES product(id),
  name         TEXT NOT NULL,                 -- local | staging | production
  url          TEXT,
  access_class TEXT NOT NULL DEFAULT 'restricted'  -- production 접근은 위험 변경 대상
);

-- ===== 정책 / 전략 (버전) =====
CREATE TABLE policy_version (
  id           TEXT PRIMARY KEY,              -- 예: policy-2026-10-14.1
  content_hash TEXT NOT NULL,                 -- policies/ 디렉터리 해시
  change_class TEXT NOT NULL CHECK (change_class IN ('normal','risky')),
  approved_by  TEXT NOT NULL,                 -- JSON: approver actor ids (risky는 2인 이상)
  deployed_at  TEXT NOT NULL,
  rollback_of  TEXT REFERENCES policy_version(id)
);

CREATE TABLE strategy_version (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT REFERENCES strategy_version(id),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  rationale_refs TEXT NOT NULL,               -- JSON: evidence/evaluation/memory ids
  status       TEXT NOT NULL CHECK (status IN ('proposed','experiment','active','retired','rejected')),
  experiment_scope TEXT,                      -- JSON: 범위/기간 제한 (status='experiment')
  created_by   TEXT NOT NULL REFERENCES actor(id),
  created_at   TEXT NOT NULL
);

-- ===== 이벤트 / 루틴 =====
CREATE TABLE event (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  external_id     TEXT,
  type            TEXT NOT NULL,
  payload         TEXT NOT NULL,              -- JSON
  product_id      TEXT REFERENCES product(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  occurred_at     TEXT NOT NULL,
  received_at     TEXT NOT NULL
);

CREATE TABLE routine (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  org_unit_id  TEXT NOT NULL REFERENCES org_unit(id),
  schedule     TEXT NOT NULL,                 -- cron + tz
  task_template TEXT NOT NULL,                -- workflows/ 템플릿 id@version
  catch_up     TEXT NOT NULL DEFAULT 'skip' CHECK (catch_up IN ('skip','run_once')),
  enabled      INTEGER NOT NULL DEFAULT 0,
  product_id   TEXT REFERENCES product(id)
);

CREATE TABLE routine_firing (
  routine_id    TEXT NOT NULL REFERENCES routine(id),
  scheduled_for TEXT NOT NULL,
  fired_at      TEXT NOT NULL,
  PRIMARY KEY (routine_id, scheduled_for)     -- 중복 발화 방지
);

-- ===== 업무 =====
CREATE TABLE task (
  id              TEXT PRIMARY KEY,
  dedupe_key      TEXT NOT NULL,
  objective       TEXT NOT NULL,
  org_unit_id     TEXT REFERENCES org_unit(id),
  role_id         TEXT REFERENCES role(id),   -- NULL이면 status='unassigned'
  role_version    INTEGER,
  org_version_id  TEXT REFERENCES org_version(id),
  product_id      TEXT REFERENCES product(id),
  trigger_kind    TEXT NOT NULL CHECK (trigger_kind IN ('event','routine','manual','task')),
  trigger_ref     TEXT NOT NULL,              -- event.id | routine_firing key | actor id | parent task id
  spec            TEXT NOT NULL,              -- JSON: task-spec.md 전체 (검증 후 저장)
  task_spec_version INTEGER NOT NULL DEFAULT 1,
  tool_contract_version TEXT,                 -- 도구 어댑터 계약 버전
  approval_id     TEXT,                       -- 실행 승인 (approval.id)
  approved_snapshot TEXT,                     -- JSON: 승인된 입력·실행 인자
  approved_hash   TEXT,                       -- approved_snapshot 해시. 실행 인자와 불일치 시 실행 차단
  status          TEXT NOT NULL CHECK (status IN
                    ('unassigned','queued','running','validating','completed','needs_review','retry_wait','failed','cancelled')),
  policy_version_id TEXT NOT NULL REFERENCES policy_version(id),
  strategy_version_id TEXT REFERENCES strategy_version(id),
  cost_budget_usd REAL NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  next_run_at     TEXT,                       -- retry_wait 복구용
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
-- 활성(비종료) 업무의 dedupe_key 중복 금지
CREATE UNIQUE INDEX task_active_dedupe ON task(dedupe_key)
  WHERE status NOT IN ('completed','failed','cancelled');

CREATE TABLE task_dependency (
  task_id      TEXT NOT NULL REFERENCES task(id),
  depends_on   TEXT NOT NULL REFERENCES task(id),
  PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE task_transition (                -- append-only
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL REFERENCES task(id),
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  caused_by    TEXT NOT NULL,                 -- actor id | 'system:validator' | 'system:scheduler'
  at           TEXT NOT NULL
);

CREATE TABLE task_run (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES task(id),
  attempt      INTEGER NOT NULL,
  actor_id     TEXT NOT NULL REFERENCES actor(id),
  adapter      TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  lease_owner  TEXT NOT NULL,                 -- 이 실행을 소유한 워커 id
  lease_expires_at TEXT NOT NULL,             -- 만료 전 heartbeat로 갱신. 만료 시 다른 워커가 인수 가능
  heartbeat_at TEXT NOT NULL,
  checkpoint   TEXT,                          -- JSON: 복구에 필요한 진행 상태
  outcome      TEXT CHECK (outcome IN ('submitted','error','timeout','killed','lease_expired','effect_unknown')),
  result       TEXT,                          -- JSON: 에이전트 구조화 결과(자기 보고)
  run_log_ref  TEXT,
  UNIQUE (task_id, attempt)
);
-- 업무당 활성(outcome IS NULL) run은 하나 — 동시 실행 방지
CREATE UNIQUE INDEX task_run_single_active ON task_run(task_id) WHERE outcome IS NULL;

-- 외부 부작용 원장 (operations/recovery.md). effect_key로 재시도 중복 방지.
CREATE TABLE external_effect (
  id           TEXT PRIMARY KEY,
  effect_key   TEXT NOT NULL UNIQUE,          -- task_id + 단계 + 입력 해시에서 결정론적으로 생성
  task_id      TEXT NOT NULL REFERENCES task(id),
  task_run_id  TEXT NOT NULL REFERENCES task_run(id),
  tool         TEXT NOT NULL,
  action       TEXT NOT NULL,
  target       TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('planned','dispatched','confirmed','failed','unknown','compensated')),
  supports_idempotency INTEGER NOT NULL,      -- 외부 시스템의 멱등 키 지원 여부
  response_ref TEXT,
  compensation_ref TEXT,
  at           TEXT NOT NULL
);

-- 정책 판정 기록 (append-only). 권한은 도구 이름이 아니라 7요소로 판정한다 (ADR-0006).
CREATE TABLE policy_decision (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT REFERENCES task(id),
  task_run_id  TEXT REFERENCES task_run(id),
  subject      TEXT NOT NULL,                 -- actor/role@version
  action       TEXT NOT NULL,
  resource     TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK (scope IN ('internal','customer','public')),
  impact       TEXT NOT NULL CHECK (impact IN ('read','write','delete','external_effect')),
  constraints  TEXT,                          -- JSON: 예산·횟수·시간·대상 수
  approval_required TEXT,                     -- JSON: 필요한 승인자/채널
  decision     TEXT NOT NULL CHECK (decision IN ('allow','deny','require_approval')),
  policy_version_id TEXT NOT NULL REFERENCES policy_version(id),
  at           TEXT NOT NULL
);

-- ===== 근거 / 비용 / 승인 =====
CREATE TABLE evidence (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES task(id),
  task_run_id  TEXT REFERENCES task_run(id),
  kind         TEXT NOT NULL CHECK (kind IN ('source_url','document','test_result','run_log','measurement','approval','other')),
  ref          TEXT NOT NULL,                 -- URL / 파일 해시 / 로그 위치
  content_hash TEXT,
  captured_at  TEXT NOT NULL,
  verified     INTEGER NOT NULL DEFAULT 0,    -- 결정론적 검사 통과 여부
  verification_note TEXT
);

CREATE TABLE cost_entry (                     -- append-only
  id           TEXT PRIMARY KEY,
  task_id      TEXT REFERENCES task(id),
  task_run_id  TEXT REFERENCES task_run(id),
  product_id   TEXT REFERENCES product(id),
  category     TEXT NOT NULL CHECK (category IN ('llm','tool','infra','external','human_time')),
  amount_usd   REAL NOT NULL,
  units        TEXT,                          -- JSON: tokens, 분 등
  at           TEXT NOT NULL
);

CREATE TABLE approval (
  id           TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('task','strategy_version','policy_version','publication','tool_call','product','org_proposal')),  -- product: 상품 등록 승인, org_proposal: 조직 제안 승인
  subject_id   TEXT NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('approved','rejected','changes_requested')),
  subject_hash TEXT,                          -- 승인 당시 대상 내용의 해시 (내용이 바뀌면 승인 무효)
  decided_by   TEXT NOT NULL REFERENCES actor(id),   -- kind='human'만 허용 (애플리케이션 규칙)
  comment      TEXT,
  at           TEXT NOT NULL
);

-- ===== 평가 (ADR-0007) =====
CREATE TABLE evaluation (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES task(id),
  task_run_id  TEXT REFERENCES task_run(id), -- 평가 대상 run (재검증 시 중복 기록 흡수용)
  evaluator    TEXT NOT NULL,                 -- 평가기 id@version
  validation_passed INTEGER NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('pass','fail','inconclusive')),  -- 증거 부족 시 억지로 결정하지 않음
  primary_evidence_refs TEXT NOT NULL,        -- JSON: 평가기가 원본에서 직접 조회한 증거 (에이전트 보고서 제외)
  agent_report_used INTEGER NOT NULL DEFAULT 0, -- 1이면 참고만 했음을 표시. 이것만으로 outcome=pass 불가 (애플리케이션 규칙)
  quality      REAL,   quality_note  TEXT,
  effect       REAL,   effect_note   TEXT,
  economics    REAL,   economics_note TEXT,
  safety       TEXT NOT NULL CHECK (safety IN ('pass','fail')),  -- 점수가 아닌 필수 조건
  safety_note  TEXT,
  evidence_refs TEXT NOT NULL,                -- JSON
  total_cost_usd REAL,
  human_minutes  REAL,
  at           TEXT NOT NULL,
  UNIQUE (task_id, task_run_id, evaluator)
);

-- ===== 기억 (ADR-0008) =====
CREATE TABLE memory_item (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('fact','commitment','measurement','hypothesis','strategy_record','lesson')),
  body         TEXT NOT NULL,
  source_ref   TEXT NOT NULL,                 -- evidence id / URL / 문서
  observed_at  TEXT NOT NULL,                 -- 실제로 관측한 시점 (created_at과 구분)
  verification_status TEXT NOT NULL DEFAULT 'unverified'
                 CHECK (verification_status IN ('unverified','verified','refuted')),
  validity     TEXT NOT NULL CHECK (validity IN ('valid','stale','superseded','refuted')),
  valid_until  TEXT,                          -- 재검토 시점 포함. 경과 시 validity='stale'
  sensitivity  TEXT NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('public','internal','confidential','restricted')),
  trust_origin TEXT NOT NULL DEFAULT 'internal' CHECK (trust_origin IN ('internal','external_untrusted')),
  superseded_by TEXT REFERENCES memory_item(id),
  product_id   TEXT REFERENCES product(id),
  policy_version_id TEXT REFERENCES policy_version(id),
  strategy_version_id TEXT REFERENCES strategy_version(id),
  created_by   TEXT NOT NULL REFERENCES actor(id),
  created_at   TEXT NOT NULL
);

-- ===== 게시 =====
CREATE TABLE publication (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES task(id),
  product_id   TEXT REFERENCES product(id),
  channel      TEXT NOT NULL,                 -- public-web | email | social ...
  audience     TEXT NOT NULL CHECK (audience IN ('internal','customer','public')),
  content_ref  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('draft','pending_approval','published','withdrawn')),
  approval_id  TEXT REFERENCES approval(id),  -- audience!='internal'이면 published에 필수 (애플리케이션 규칙)
  published_at TEXT
);

-- ===== append-only 강제 (SQLite 트리거; Postgres 이식 시 동등한 규칙/트리거로 교체) =====
CREATE TRIGGER task_transition_no_update BEFORE UPDATE ON task_transition BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER task_transition_no_delete BEFORE DELETE ON task_transition BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER cost_entry_no_update BEFORE UPDATE ON cost_entry BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER cost_entry_no_delete BEFORE DELETE ON cost_entry BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER policy_decision_no_update BEFORE UPDATE ON policy_decision BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER policy_decision_no_delete BEFORE DELETE ON policy_decision BEGIN SELECT RAISE(ABORT, 'append-only'); END;
