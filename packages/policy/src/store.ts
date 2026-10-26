// 정책 내용 저장소. DB 의 policy_version 은 배포 기록(id, content_hash, 승인자)이고, 내용은 파일이다 (schema: content_hash).
//  - 템플릿: 저장소의 `policies/default.yaml` 등 (시드의 policy-v1 이 가리킨다)
//  - 보관소: `instance/policies/<content_hash>.yaml` — 승인 엔진이 배포 승인 때 내용을 그대로 보관한다(0600, 디렉터리 0700)
// 읽을 때마다 내용 해시를 다시 계산해 policy_version.content_hash 와 같은지 확인한다. 다르거나 없으면 null(호출자는 거부).
// 에이전트 프로세스는 이 디렉터리에 접근할 수 없어야 한다 (ADR-0006, trust-boundaries §3.1-2).
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Db } from '@aot/domain';

import { parsePolicy, type ParsedPolicy } from './document.ts';

export interface ActivePolicy extends ParsedPolicy {
  /** 배포된 policy_version.id (시드의 `policy-v1` 처럼 내용 해시와 다른 이름일 수 있다) */
  versionId: string;
}

export interface PolicyStoreOptions {
  /** 보관소 디렉터리 (instance/policies). 없으면 만든다(0700) */
  dir: string;
  /** 저장소 템플릿 파일 경로들 */
  templates?: readonly string[];
}

const HASH = /^[0-9a-f]{64}$/;

export class PolicyStore {
  readonly dir: string;
  readonly #templates: readonly string[];
  readonly #cache = new Map<string, ParsedPolicy>();

  constructor(options: PolicyStoreOptions) {
    this.dir = options.dir;
    this.#templates = options.templates ?? [];
  }

  /** 내용 해시로 정책을 찾는다. 해시가 맞는 파일이 없으면 null. */
  byHash(hash: string): ParsedPolicy | null {
    if (!HASH.test(hash)) return null;
    const cached = this.#cache.get(hash);
    if (cached) return cached;
    const candidates = [join(this.dir, `${hash}.yaml`), ...this.#templates];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      const parsed = parsePolicy(readFileSync(path, 'utf8'));
      if (parsed.ok && parsed.value.hash === hash) {
        this.#cache.set(hash, parsed.value);
        return parsed.value;
      }
    }
    return null;
  }

  /** 승인 엔진이 배포 승인 때 부른다. 내용 해시 이름으로 보관하고(이미 있으면 그대로), 검증된 정책을 돌려준다. */
  archive(text: string): ParsedPolicy {
    const parsed = parsePolicy(text);
    if (!parsed.ok) throw new PolicyFormatError(parsed.errors.map((e) => `${e.path || '(root)'}: ${e.message}`));
    this.#ensureDir();
    const path = join(this.dir, `${parsed.value.hash}.yaml`);
    if (!existsSync(path)) {
      writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
    }
    this.#cache.set(parsed.value.hash, parsed.value);
    return parsed.value;
  }

  /** 보관된 정책 해시 목록 (진단용) */
  archived(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((name) => /^[0-9a-f]{64}\.yaml$/.test(name)).map((name) => name.slice(0, 64)).sort();
  }

  /** 지금 배포된 정책 (가장 최근 policy_version). 내용을 찾을 수 없으면 null — 판정은 거부로 간다. */
  active(db: Db): { versionId: string; contentHash: string; policy: ActivePolicy | null } | null {
    const row = db.get<{ id: string; content_hash: string }>('SELECT id, content_hash FROM policy_version ORDER BY deployed_at DESC, rowid DESC LIMIT 1');
    if (!row) return null;
    const parsed = this.byHash(row.content_hash);
    return { versionId: row.id, contentHash: row.content_hash, policy: parsed ? { ...parsed, versionId: row.id } : null };
  }

  #ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if ((statSync(this.dir).mode & 0o077) !== 0) chmodSync(this.dir, 0o700);
  }
}

export class PolicyFormatError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid policy: ${problems.join('; ')}`);
    this.name = 'PolicyFormatError';
    this.problems = problems;
  }
}
