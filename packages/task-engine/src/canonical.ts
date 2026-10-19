// 정규화 JSON 과 해시는 domain 에 있다 (policy 도 같은 규칙으로 승인 대상 해시를 만든다). 기존 이름을 유지한다.
export { canonicalJson, sha256Hex as sha256 } from '@aot/domain';
