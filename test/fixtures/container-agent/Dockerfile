# 컨테이너 샌드박스 OS 수준 시험용 가짜 에이전트 이미지 (스파이크 Q26 §6 후보 A). 시험(test/integration/container-sandbox.test.ts)이 빌드해 이미지 ID 로 실행한다.
# 기준 이미지는 다중 아키텍처 인덱스 digest 로 고정한다. 갱신은 digest 변경 커밋으로 한다.
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
# 파일 0644 root 소유: 읽기 전용 루트에서 비루트가 읽기만 한다 (`--chmod=0444` 는 새 상위 디렉터리까지 0444 로 만들어 읽기 실패했다)
COPY --chown=0:0 agent.mjs /opt/agent/agent.mjs
USER 65532:65532
WORKDIR /work
ENTRYPOINT ["/nodejs/bin/node", "/opt/agent/agent.mjs"]
