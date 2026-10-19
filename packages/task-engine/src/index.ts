// @aot/task-engine 공개 API 진입점 (단계 A2). 구현 전 골격이다.
// 책임: 업무 생성(멱등), 스케줄러·폴링, task_run lease, external_effect 상태 머신, 재시작 복구
// 다른 패키지는 이 파일로만 참조한다 (경계 lint: .dependency-cruiser.cjs).
export {};
