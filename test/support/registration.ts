// 상품 등록 검증 업무(registration-report@1) 시험 공용: 호스트가 저장한 근거 본문을 흉내 내는 가짜 EvidenceReader, 근거 행 만들기, 정상 보고서.
// 실제 저장소·스캐너는 쓰지 않는다. 예시는 모두 가상의 example-product 다.
import { createHash } from 'node:crypto';

import type { Db, FakeClock } from '@aot/domain';
import { SECRET_SCAN_SUMMARY_TYPE, type EvidenceContent, type EvidenceReader } from '@aot/evaluation';

import { addEvidence, type SubmittedRun } from './evaluation.ts';

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** 근거 id → 본문. 없는 id 는 읽을 수 없음. 던지게 할 id 도 정할 수 있다 */
export class FakeEvidenceReader implements EvidenceReader {
  readonly reads: string[] = [];
  readonly contents = new Map<string, string>();
  readonly throwing = new Set<string>();

  read(row: { id: string }): Promise<EvidenceContent> {
    this.reads.push(row.id);
    if (this.throwing.has(row.id)) return Promise.reject(new Error('disk failure'));
    const text = this.contents.get(row.id);
    return Promise.resolve(text === undefined ? { readable: false, reason: 'not found in the store' } : { readable: true, text });
  }
}

export const scanSummary = (scope: 'tree' | 'history', overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: SECRET_SCAN_SUMMARY_TYPE,
  scope,
  complete: true,
  scanner: 'gitleaks@8.30.1',
  ...(scope === 'tree' ? { files_scanned: 42 } : { commits_scanned: 17 }),
  findings: [],
  ...overrides,
});

export interface RegistrationFixture {
  reader: FakeEvidenceReader;
  /** 근거 행을 넣고 본문을 저장소에 둔다. `hash` 로 기록된 해시를 어긋나게 할 수 있다(null = 해시 없음) */
  put(run: SubmittedRun, id: string, text: string, options?: { kind?: string; hash?: string | null; trustOrigin?: 'internal' | 'external_untrusted' }): void;
}

export function registrationFixture(db: Db, clock: FakeClock): RegistrationFixture {
  const reader = new FakeEvidenceReader();
  return {
    reader,
    put(run, id, text, options = {}) {
      reader.contents.set(id, text);
      addEvidence(db, clock, run, {
        id, kind: options.kind ?? 'document', ref: `blob:${sha256(text).slice(0, 12)}`,
        contentHash: options.hash === undefined ? sha256(text) : options.hash, trustOrigin: options.trustOrigin ?? 'internal',
      });
    },
  };
}

/** 보고서가 가리키는 근거 id */
export const IDS = {
  tree: 'ev-scan-tree', history: 'ev-scan-history', structure: 'ev-structure', readme: 'ev-readme', rationale: 'ev-rationale',
} as const;

/** 정상 보고서(registration-report@1): 모든 수집 항목이 근거로 연결되고 분류는 internal. `overrides` 로 최상위 필드를 바꾼다 */
export function registrationReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const collected = (item: string, ...evidence_ids: string[]) => ({ item, status: 'collected', evidence_ids });
  return {
    claims: [
      { id: 'c1', statement: 'The repository has a src directory and a README.', evidence_id: IDS.structure },
      { id: 'c2', statement: 'The README describes a small command line tool.', evidence_id: IDS.readme },
    ],
    collection: [
      collected('repo_structure', IDS.structure),
      collected('stack', IDS.structure),
      collected('readme_summary', IDS.readme),
      { item: 'remote', status: 'unavailable', reason: 'the repository has no remote configured' },
      collected('default_branch', IDS.structure),
      collected('activity_history', IDS.structure),
      collected('license', IDS.structure),
      collected('environment', IDS.readme),
      collected('secret_scan', IDS.tree, IDS.history),
    ],
    classification: { proposal: 'internal', rationale_evidence_ids: [IDS.rationale] },
    uncertainties: [],
    ...overrides,
  };
}

export const STRUCTURE_TEXT = JSON.stringify({ tree: ['README.md', 'src/index.ts'], stack: ['typescript'] });
export const README_TEXT = 'example-product is a small command line tool.\nUsage: run it from a shell.';

/** 정상 보고서가 가리키는 근거 5개를 저장한다 */
export function putRegistrationEvidence(fixture: RegistrationFixture, run: SubmittedRun, options: { tree?: Record<string, unknown>; history?: Record<string, unknown>; readme?: string } = {}): void {
  fixture.put(run, IDS.structure, STRUCTURE_TEXT);
  fixture.put(run, IDS.readme, options.readme ?? README_TEXT, { trustOrigin: 'external_untrusted' });
  fixture.put(run, IDS.tree, JSON.stringify(options.tree ?? scanSummary('tree')));
  fixture.put(run, IDS.history, JSON.stringify(options.history ?? scanSummary('history')));
  fixture.put(run, IDS.rationale, 'The project has no secret candidates but its license is not identified, so internal.');
}
