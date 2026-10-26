// license_check 도구 실행기 (identify). **사실만 보고한다**: 라이선스 파일의 이름·해시·SPDX 헤더·잘 알려진 문구, 매니페스트의 license 필드. 어느 라이선스인지의 판단과
// 의존성 라이선스는 이 도구의 일이 아니다(판단은 사람, 의존성은 후속). 문구 인식(`phrases`)은 휴리스틱이라 확정이 아니라 단서로만 쓴다.
import { createHash } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';

import type { JsonObject, JsonValue } from '../contract.ts';
import type { ToolExecutionRequest, ToolExecutionResult } from '../gateway.ts';
import type { RegistrationToolRun } from './capture.ts';
import { readTextFile, replaceControlChars, RepoToolError } from './repo-files.ts';

export const LICENSE_CHECK_TOOL = 'license_check';
export const LICENSE_CHECK_OPERATIONS = ['identify'] as const;

const LICENSE_FILE = /^(licen[sc]e|copying|unlicense|notice)([-._].*)?$/i;
const MAX_LICENSE_FILES = 5;
const MAX_LICENSE_BYTES = 128 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;

/** 문구 → 단서 이름. 모두 만족해야 일치한다 */
const PHRASES: readonly { id: string; all: readonly RegExp[] }[] = [
  { id: 'MIT', all: [/permission is hereby granted, free of charge/i, /the software is provided "as is"/i] },
  { id: 'Apache-2.0', all: [/apache license/i, /version 2\.0/i] },
  { id: 'GPL-3.0', all: [/gnu general public license/i, /version 3, 29 june 2007/i] },
  { id: 'GPL-2.0', all: [/gnu general public license/i, /version 2, june 1991/i] },
  { id: 'LGPL', all: [/gnu lesser general public license/i] },
  { id: 'AGPL-3.0', all: [/gnu affero general public license/i] },
  { id: 'MPL-2.0', all: [/mozilla public license/i, /version 2\.0/i] },
  { id: 'BSD', all: [/redistribution and use in source and binary forms/i] },
  { id: 'ISC', all: [/permission to use, copy, modify, and\/or distribute this software for any purpose/i] },
  { id: 'Unlicense', all: [/this is free and unencumbered software released into the public domain/i] },
];

const SPDX = /SPDX-License-Identifier:\s*([A-Za-z0-9.+() -]{1,80})/;

/** 매니페스트의 license 필드 값을 뽑는다 (파일 이름 → 값). 모양이 다르면 null */
export function manifestLicense(file: string, text: string): string | null {
  const clean = (value: string): string => replaceControlChars(value).trim().slice(0, 100);
  if (file === 'package.json' || file === 'composer.json') {
    try {
      const parsed = JSON.parse(text) as { license?: unknown; licenses?: unknown };
      if (typeof parsed.license === 'string') return clean(parsed.license);
      if (typeof parsed.license === 'object' && parsed.license !== null && typeof (parsed.license as { type?: unknown }).type === 'string') return clean((parsed.license as { type: string }).type);
      if (Array.isArray(parsed.license)) return clean(parsed.license.filter((x): x is string => typeof x === 'string').join(' OR '));
    } catch {
      return null;
    }
    return null;
  }
  if (file === 'Cargo.toml' || file === 'pyproject.toml') {
    const match = /^\s*license\s*=\s*(?:"([^"\n]+)"|\{\s*(?:text|file)\s*=\s*"([^"\n]+)"\s*\})/m.exec(text);
    return match ? clean(match[1] ?? match[2] ?? '') : null;
  }
  return null;
}

const MANIFESTS = ['package.json', 'Cargo.toml', 'pyproject.toml', 'composer.json'] as const;

export function createLicenseCheckExecutor(deps: { run: RegistrationToolRun }) {
  const { run } = deps;

  async function identify(): Promise<JsonValue> {
    const { root } = run.repo();
    let names: string[];
    try {
      names = (await readdir(await realpath(root))).sort();
    } catch {
      throw new RepoToolError('repo_not_bound', 'the repository root cannot be read');
    }
    const licenseFiles: JsonObject[] = [];
    for (const name of names.filter((candidate) => LICENSE_FILE.test(candidate)).slice(0, MAX_LICENSE_FILES)) {
      const file = await readTextFile(root, name, MAX_LICENSE_BYTES);
      if (!file.ok) {
        licenseFiles.push({ path: name, status: 'unavailable', reason: file.reason });
        continue;
      }
      const spdx = SPDX.exec(file.text);
      licenseFiles.push({
        path: name,
        sha256: createHash('sha256').update(file.text, 'utf8').digest('hex'),
        bytes: file.bytes,
        truncated: file.truncated,
        ...(spdx ? { spdx_header: spdx[1]!.trim() } : {}),
        phrases: PHRASES.filter((phrase) => phrase.all.every((pattern) => pattern.test(file.text))).map((phrase) => phrase.id),
      });
    }
    const manifestFields: JsonObject[] = [];
    for (const name of MANIFESTS.filter((candidate) => names.includes(candidate))) {
      const file = await readTextFile(root, name, MAX_MANIFEST_BYTES);
      if (!file.ok) continue;
      const value = manifestLicense(name, file.text);
      if (value !== null && value !== '') manifestFields.push({ file: name, license: value });
    }
    const record: JsonObject = {
      type: 'license_facts@1',
      license_files: licenseFiles,
      manifest_fields: manifestFields,
      dependency_licenses: 'not_collected',
    };
    let captured;
    try {
      captured = await run.evidence.capture({ text: JSON.stringify(record), trustOrigin: 'external_untrusted' });
    } catch (error) {
      throw new RepoToolError('capture_failed', error instanceof Error ? error.message : String(error));
    }
    return { ...record, evidence_id: captured.evidenceId };
  }

  return async function execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    if (request.operation !== 'identify') throw new RepoToolError('invalid_args', `unknown license_check operation '${request.operation.slice(0, 40)}'`);
    const extra = Object.keys(request.args);
    if (extra.length > 0) throw new RepoToolError('invalid_args', `license_check takes no arguments (got ${extra.join(', ')})`);
    return { result: await identify() };
  };
}
