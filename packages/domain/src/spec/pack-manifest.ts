// 팩 manifest 형식 검증 (ADR-0012 §1: 이름, 버전, 요구 코어 버전, 필요한 도구, 구성 디렉터리).
// 형식만 본다. 팩의 채택·권한은 코어의 정책·승인 경로가 정하며 manifest 로 얻을 수 없다 (ADR-0012 §3).
// 측정 신호 정의의 형식은 measurement-signal.ts 가 검증하고, 정의 파일의 위치는 `contents.measurement_signals` 로 선언한다 (A6-U10).
import {
  IssueCollector, isNonBlankString, isPlainObject, joinPath, rejectUnknownKeys, type ValidationResult,
} from '../validation.ts';

export const PACK_CONTENT_KEYS = ['workflows', 'routines', 'evaluations', 'policy_examples', 'measurement_signals'] as const;
export type PackContentKey = (typeof PACK_CONTENT_KEYS)[number];

export interface PackManifest {
  name: string;
  version: string;
  requires_core: string;
  required_tools: string[];
  contents?: Partial<Record<PackContentKey, string>>;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const COMPARATOR = /^(?:>=|<=|>|<|=)?\d+\.\d+\.\d+$/;

export function validatePackManifest(input: unknown): ValidationResult<PackManifest> {
  const out = new IssueCollector();
  if (!isPlainObject(input)) {
    out.add('', 'type', 'manifest must be a JSON object');
    return out.result(input as PackManifest);
  }
  // `_comment` 는 사람이 읽는 메모라 허용한다.
  rejectUnknownKeys(input, ['_comment', 'name', 'version', 'requires_core', 'required_tools', 'contents'], '', out);
  if ('_comment' in input && typeof input['_comment'] !== 'string') out.add('_comment', 'type', '_comment must be a string');

  if (typeof input['name'] !== 'string' || !NAME.test(input['name'])) out.add('name', 'format', 'name must be lowercase letters, digits and hyphens (e.g. example-marketing)');
  if (typeof input['version'] !== 'string' || !SEMVER.test(input['version'])) out.add('version', 'format', 'version must look like 1.2.3');

  const range = input['requires_core'];
  if (!isNonBlankString(range) || !range.trim().split(/\s+/).every((part) => COMPARATOR.test(part))) {
    out.add('requires_core', 'format', 'requires_core must be space-separated comparators such as ">=0.0.0 <1.0.0"');
  }

  const tools = input['required_tools'];
  if (!Array.isArray(tools)) {
    out.add('required_tools', 'required', 'required_tools must be an array of tool names (it may be empty)');
  } else {
    const seen = new Set<string>();
    tools.forEach((tool: unknown, index) => {
      const path = joinPath('required_tools', index);
      if (!isNonBlankString(tool)) return void out.add(path, 'type', 'tool name must be a non-empty string');
      if (seen.has(tool)) out.add(path, 'duplicate', `duplicate tool '${tool}'`);
      seen.add(tool);
    });
  }

  if ('contents' in input) {
    const contents = input['contents'];
    if (!isPlainObject(contents)) {
      out.add('contents', 'type', 'contents must be an object');
    } else {
      rejectUnknownKeys(contents, PACK_CONTENT_KEYS, 'contents', out);
      for (const key of PACK_CONTENT_KEYS) {
        if (!(key in contents)) continue;
        const dir = contents[key];
        const path = joinPath('contents', key);
        if (!isNonBlankString(dir)) out.add(path, 'type', 'must be a relative directory path');
        else if (dir.startsWith('/') || /^[A-Za-z]:/.test(dir) || dir.split('/').includes('..')) {
          out.add(path, 'path', 'must stay inside the pack directory (no absolute path, no "..")');
        }
      }
    }
  }
  return out.result(input as unknown as PackManifest);
}
