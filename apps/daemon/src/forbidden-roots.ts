// 상품 저장소 경로가 겹치면 안 되는 데몬 디렉터리 목록 (main.ts 에서 분리, 동작 변경 없음).
// 설정으로 인스턴스 밖에 둘 수 있는 DB·TOTP·정책 저장소·승인 소켓: 상품 저장소가 이것을 품으면 에이전트가 DB·TOTP·정책을 읽을 길이 열린다.
import { resolve } from 'node:path';

import { defaultInstancePaths } from './assemble.ts';

export interface ForbiddenRootsConfig {
  db_path: string;
  totp_dir?: string;
  policy_store_dir?: string;
  approval_socket?: string;
}

/** 설정이 없는 항목은 인스턴스 기본 경로를 쓴다. 결과는 모두 절대 경로(`resolve`). */
export function daemonForbiddenRoots(config: ForbiddenRootsConfig, instanceDir: string): string[] {
  const defaults = defaultInstancePaths(instanceDir);
  return [
    config.db_path,
    config.totp_dir ?? defaults.totpDir,
    config.policy_store_dir ?? defaults.policyStoreDir,
    config.approval_socket ?? defaults.approvalSocket,
  ].map((path) => resolve(path));
}
