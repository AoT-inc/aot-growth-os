# 읽기 전용 조사 에이전트 이미지 (A5 U5). 빌드 컨텍스트는 packages/agent-runtime 이다(공유 코드 src/wire.ts·src/line-reader.ts 를 같은 상대 경로로 넣기 위해):
#   docker build -q -f packages/agent-runtime/container/research-agent/Dockerfile -t <태그> packages/agent-runtime
# 기준 이미지는 U3 의 시험용 이미지(test/fixtures/container-agent/Dockerfile)와 같은 다중 아키텍처 인덱스 digest 다(드리프트 시험이 두 파일의 digest 가 같은지 본다).
# 갱신은 digest 변경 커밋으로 한다. 데몬은 빌드 결과의 이미지 ID(sha256:…)로만 실행한다(태그로 실행하지 않음).
# 컨테이너에는 의존성이 없다: 에이전트 코드는 .ts 를 Node 24 의 타입 제거 실행으로 그대로 돌리고(빌드 단계 없음), node: 내장 모듈과 아래 세 곳의 상대 import 만 쓴다.
#   src/wire.ts, src/line-reader.ts (호스트와 공유하는 의존성 없는 모듈), container/research-agent/{core,agent}.ts
# 파일은 0644 root 소유: 읽기 전용 루트에서 비루트가 읽기만 한다.
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
COPY --chown=0:0 container/research-agent/image-package.json /opt/agent/package.json
COPY --chown=0:0 src/wire.ts src/line-reader.ts /opt/agent/src/
COPY --chown=0:0 container/research-agent/core.ts container/research-agent/agent.ts /opt/agent/container/research-agent/
USER 65532:65532
WORKDIR /work
ENTRYPOINT ["/nodejs/bin/node", "/opt/agent/container/research-agent/agent.ts"]
