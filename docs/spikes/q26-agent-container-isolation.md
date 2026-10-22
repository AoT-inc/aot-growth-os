# 스파이크 Q26: 에이전트 컨테이너 격리와 게이트웨이 통신

상태: 완료 (2026-10-22) · 관련: [open-questions Q26](../open-questions.md), [trust-boundaries §3·§3.1](../security/trust-boundaries.md), [ADR-0005](../adr/0005-agent-adapter-boundary.md), [phase-a A5·§3](../plans/phase-a.md)

격리 방식 = 컨테이너(Docker)는 사용자가 정했다(2026-10-22). 이 스파이크는 남은 세 가지(게이트웨이 통신 방식, 파일시스템·네트워크 허용 목록 강제, 데몬 실행 환경의 Docker 전제)를 정한다.

## 결론

- **통신: stdio 파이프.** 데몬이 `docker run -i`로 컨테이너를 띄우고 stdin/stdout에 줄 단위 JSON 프레임을 주고받는다. 컨테이너에는 네트워크가 없다(`--network none`). Unix 소켓 마운트는 Docker Desktop(macOS)에서 `connect`가 실패해 쓸 수 없었고, 호스트 TCP(`host.docker.internal`)는 호스트의 **127.0.0.1에만 열린 서비스까지** 닿아 탈락했다.
- **허용 목록 강제: 기본 가설이 맞았다.** 네트워크는 `--network none`(루프백만 있음), 외부 접근은 전부 게이트웨이 도구 호출로 한다. 파일시스템은 **바인드 마운트 0개**, 루트 파일시스템 읽기 전용, 작업 디렉터리는 크기 제한 tmpfs다. 업무 입력·출력은 프레임으로만 오간다.
- **Docker 전제: 데몬 호스트에 Docker Engine과 `docker` CLI가 있어야 하고, 데몬은 `child_process.spawn`으로 CLI를 호출한다(의존성 추가 없음).** Docker를 쓸 수 없으면 에이전트 업무를 실행하지 않는다(호스트 직접 실행으로 대체하지 않음). Docker 소켓 접근은 사실상 root 권한이다(아래 위험).
- **A3 편차(피어 UID 미확인): 에이전트 경로에 대해서는 해소.** 컨테이너에서 `instance/run/` 소켓·TOTP 비밀·DB·`policies/`가 존재하지 않음(ENOENT)을 확인했다. 피어 UID 확인용 네이티브 애드온은 넣지 않는다. 남는 틈은 "남은 위험"에 적었다.

## 판정 기준 (시험 전에 고정)

관리 세션이 착수 시 정한 7개 기준이다. 통과 = 실제로 실행해 확인했고 재현 명령이 이 문서에 있다. 결과를 보고 바꾼 기준은 없다.

| # | 기준 | 판정 | 근거 (아래 절) |
|---|---|---|---|
| 1 | 컨테이너에서 호스트 `instance/`·DB·`policies/`가 보이지 않는다 | **통과** (macOS 실측) | §1: 가짜 instance의 모든 경로 ENOENT. 마운트 목록에 호스트 경로 없음 |
| 2 | 외부 네트워크 직접 연결 실패, 게이트웨이 경로로만 통신 | **통과** (macOS 실측) | §2: 공인 IP·DNS·호스트 게이트웨이 IP 전부 ENETUNREACH/EAI_AGAIN, 호스트 리스너 접속 기록 증가 0 |
| 3 | 선택한 방식으로 왕복, 임의 호스트 프로세스 도달 불가, 취소·시간 제한 종료 | **통과** (macOS 실측) | §3: stdio 왕복·거부 도구 응답, 시간 제한 `docker kill` → 137, stdin 닫기 취소. CLI 프로세스만 죽이면 컨테이너가 남는다(대응 포함) |
| 4 | 최소 권한 플래그 조합과 위반 시도 실패 | **통과** (macOS 실측) | §4: 비루트, 읽기 전용(EROFS), CapEff 0, NoNewPrivs 1, tmpfs noexec·크기, 메모리 OOM 137, CPU 0.54, pids EAGAIN |
| 5 | 데몬의 Docker 호출 방법, 의존성, 권한 위험 | **통과** (결정 + macOS 실측, Linux 권한 모델은 미실측) | §5: CLI `spawn` 실측, Engine API도 `node:http`로 호출됨을 실측. CLI 채택 |
| 6 | 최소 이미지 후보와 digest 고정 방식 | **통과** (macOS arm64 빌드 실측) | §6: distroless nodejs24 nonroot, 인덱스 digest 고정 빌드 |
| 7 | A3 편차가 컨테이너 격리로 해소되는가 | **해소** (에이전트 경로, macOS 실측) | §1·§7: `instance/run/approval.sock` ENOENT. 남는 틈은 "남은 위험" |

Linux 서버(네이티브 Docker Engine)는 **실측하지 않았다**. Linux 관련 서술은 Docker 문서·일반 지식이며 그렇게 표시했다. A5의 OS 수준 시험을 CI(Linux 러너)에서 돌리면 Linux 실측이 된다.

## 실험 환경

- macOS(arm64) + Docker Desktop 29.6.2(서버 linux/arm64, 커널 6.12 linuxkit, cgroup v2, seccomp 기본 프로필), 호스트 Node 24.22.0.
- 가짜 instance: 임시 디렉터리에 `instance/run/approval.sock`(0700 디렉터리, 0600 소켓, 접속하면 응답하는 가짜 서버), `instance/totp/owner.secret`(가짜 문자열, 0600), `instance/aot.db`(빈 SQLite, 0600), `policies/default.yaml`. 실제 비밀값은 없다.
- 호스트 리스너: `127.0.0.1:47001`, `0.0.0.0:47002`(접속하면 기록).
- 아래 명령에서 `$H`는 강화 플래그 묶음이다(zsh는 배열로 둔다).

```sh
H=(--rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges
   --tmpfs /work:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=0700 --workdir /work
   --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 32 --ipc none --log-driver none
   --user 1000:1000)
IMG=node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
```

## 1. 파일시스템: 호스트 경로가 보이지 않는다 (기준 1·7)

```sh
docker run $H $IMG node -e '
const fs=require("fs"), F=process.argv[1];
for (const p of [F+"/instance", F+"/instance/run/approval.sock", F+"/instance/totp/owner.secret", F+"/instance/aot.db",
  F+"/policies", "/Users","/private","/Volumes","/host_mnt","/var/run/docker.sock","/run/host-services","/mnt/host"])
  { try { fs.statSync(p); console.log("VISIBLE", p) } catch (e) { console.log("absent", e.code, p) } }
console.log(fs.readFileSync("/proc/self/mounts","utf8")); console.log(Object.keys(process.env))' "$FAKE"
# FAKE = 가짜 instance의 부모 디렉터리(호스트 절대 경로)
```

```
absent ENOENT <FAKE>/instance                       # run/approval.sock, totp/owner.secret, aot.db, policies 모두 ENOENT
absent ENOENT /Users  /private  /Volumes  /host_mnt  /var/run/docker.sock  /run/host-services  /mnt/host
마운트: overlay / (ro), proc, sysfs(ro), cgroup2(ro), /dev tmpfs, /work tmpfs(noexec), /etc/{resolv.conf,hostname,hosts}(ro)
환경 변수: HOME, HOSTNAME, NODE_VERSION, PATH, PWD, YARN_VERSION   # 비밀·DB 경로 없음
```

**대조군(잘못 마운트한 경우).** `-v "$FAKE/instance":/inst:ro`로 마운트하면 컨테이너 UID 1000이 `/inst/totp/owner.secret`과 `/inst/aot.db`를 **읽었다**. Docker Desktop의 파일 공유는 마운트된 파일의 소유자를 컨테이너 사용자로 보이게 하므로(`stat`: uid 1000, mode 600) 호스트의 0600·0700 권한이 아무것도 막지 못한다. 따라서 보호 수단은 "마운트하지 않는다"뿐이며, 이를 코드와 시험으로 강제해야 한다(남은 위험 1).

## 2. 네트워크: 직접 연결 실패, 게이트웨이로만 (기준 2)

```sh
docker run $H $IMG node -e '
const net=require("net"),dns=require("dns"),os=require("os");
console.log("IFACES", Object.keys(os.networkInterfaces()));
dns.lookup("example.com", e => console.log("DNS", e ? e.code : "resolved"));
for (const [h,p] of [["1.1.1.1",443],["8.8.8.8",53],["host.docker.internal",47001],["host.docker.internal",47002],
  ["192.168.65.254",47002],["172.17.0.1",47002],["gateway.docker.internal",47002],["example.com",443]]) {
  const s=net.connect({host:h,port:p,timeout:3000});
  s.on("connect",()=>{console.log("CONNECTED",h,p);s.destroy()}); s.on("timeout",()=>{console.log("timeout",h,p);s.destroy()});
  s.on("error",e=>console.log("fail",e.code,h,p)); }'
# 대조군: --network none 대신 기본 bridge, 또는 docker network create --internal 로 만든 네트워크
```

| 대상 | `--network none` | 기본 bridge (대조군) | `--internal` 네트워크 |
|---|---|---|---|
| 인터페이스 | `lo`만 | `lo`, `eth0` | `lo`, `eth0` |
| DNS `example.com` | EAI_AGAIN | 해석됨 | EAI_AGAIN |
| `1.1.1.1:443`, `8.8.8.8:53` | ENETUNREACH | **연결됨** | ENETUNREACH |
| `host.docker.internal:47001` (호스트 **127.0.0.1** 전용 리스너) | EAI_AGAIN | **연결됨** | EAI_AGAIN |
| `host.docker.internal:47002`, `192.168.65.254:47002` | 실패 | **연결됨** | 실패 |
| `172.17.0.1`, `gateway.docker.internal` | 실패 | 거부/시간 초과 | 실패 |
| 컨테이너 내부 루프백 `127.0.0.1:18080` | 동작 | 동작 | 동작 |

- `--network none` 실행 전후 호스트 리스너 접속 기록: 5 → 5(증가 없음). bridge 대조군에서는 127.0.0.1 전용 리스너에도 접속이 기록되었다.
- 게이트웨이 경로로의 통신은 §3의 stdio 왕복으로 확인했다.
- 컨테이너 내부 루프백은 `--network none`에서도 쓸 수 있다. HTTP로 모델 API를 부르는 에이전트 제품은 컨테이너 안 shim이 `127.0.0.1`에서 받아 stdio 프레임으로 게이트웨이에 넘기는 방식으로 붙일 수 있다(미구현, 남은 위험 5).

## 3. 통신 방식 비교와 stdio 왕복·취소 (기준 3)

| 후보 | macOS 실측 | Linux (실측 안 함) | 판정 |
|---|---|---|---|
| (1) stdio 파이프 (`docker run -i --network none`, 줄 단위 JSON) | 왕복·거부 응답·취소·시간 제한 동작 | 같은 방식으로 동작할 것으로 본다(CLI·커널 기능만 씀) | **채택** |
| (2) Unix 소켓 마운트 | 공유 디렉터리(`-v dir:/gw`)의 소켓에 `stat`·`connect` 모두 **ENOTSUP**(루트 사용자도 같음). 읽기 전용 마운트에서는 ECONNREFUSED | 네이티브로 동작하는 것으로 알려져 있다. 마운트한 디렉터리 전체가 노출되므로 소켓 전용 디렉터리가 필요 | 탈락 (macOS 불가, 플랫폼별 분기 필요) |
| (3) 호스트 TCP + 토큰 | bridge에서 호스트 127.0.0.1 전용 서비스까지 도달, 인터넷 전체도 열림. `--internal`로 막으면 호스트에도 닿지 않음 | `--add-host host-gateway` 필요. 호스트에서 docker0·0.0.0.0에 열린 서비스가 노출 | 탈락 (임의 호스트 프로세스 도달) |

시험 하네스(호스트 `host.mjs`, 컨테이너 `agent.js`)는 이 문서에만 싣는다. stdout은 프레임 전용, 로그는 stderr다.

```js
// agent.js — 이미지에 넣는 가짜 에이전트. 인자: roundtrip | hang | hostile(stdin EOF 무시)
'use strict';
const rl = require('node:readline').createInterface({ input: process.stdin });
const mode = process.argv[2] || 'roundtrip', pending = new Map(); let next = 1;
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const call = (tool, args) => new Promise((r) => { const id = next++; pending.set(id, r); send({ type: 'tool_call', id, tool, args }); });
rl.on('line', (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); pending.delete(m.id); });
rl.on('close', () => { if (mode !== 'hostile') process.exit(3); });
(async () => {
  if (mode === 'roundtrip') {
    const a = await call('echo', { text: 'hello' }), b = await call('fetch_url', { url: 'https://example.com/' }), c = await call('denied_tool', {});
    send({ type: 'result', result: { a: a.result, b_status: b.result?.status, c_error: c.error }, cost: { tokens: 0 } }); process.exit(0);
  }
  await call('echo', { text: 'before-hang' }); setInterval(() => {}, 1 << 30);
})();
```

```js
// host.mjs — node host.mjs <image> <mode> [timeoutMs] [docker-kill|close-stdin|sigkill-cli]
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
const [image, mode, timeoutMs = '0', how = 'docker-kill'] = process.argv.slice(2);
const name = `q26-run-${randomUUID().slice(0, 8)}`;
const HARDEN = ['--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--tmpfs', '/work:rw,noexec,nosuid,nodev,size=16m', '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5',
  '--pids-limit', '32', '--ipc', 'none', '--log-driver', 'none', '--label', 'aot.q26=1'];
const ALLOWED = new Set(['echo', 'fetch_url']);
const ps = () => execFileSync('docker', ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Status}}']).toString().trim() || '(gone)';
const child = spawn('docker', ['run', '-i', '--rm', '--name', name, ...HARDEN, image, mode], { stdio: ['pipe', 'pipe', 'inherit'] });
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  console.log('<-', line); const m = JSON.parse(line);
  if (m.type !== 'tool_call') return;
  const reply = !ALLOWED.has(m.tool) ? { error: 'tool_not_allowed' }
    : { result: m.tool === 'echo' ? m.args : { status: 200 } };              // fetch_url은 게이트웨이가 대신 수행한다고 가정
  child.stdin.write(JSON.stringify({ type: 'tool_result', id: m.id, ...reply }) + '\n');
});
const timer = Number(timeoutMs) > 0 && setTimeout(() => {
  console.log('time limit exceeded ->', how, '| before:', ps());
  if (how === 'docker-kill') execFileSync('docker', ['kill', name]);
  if (how === 'close-stdin') child.stdin.end();
  if (how === 'sigkill-cli') { child.kill('SIGKILL'); setTimeout(() => { console.log('5s after CLI SIGKILL:', ps()); execFileSync('docker', ['kill', name]); }, 5000); }
}, Number(timeoutMs));
child.on('exit', (code, sig) => { clearTimeout(timer); console.log('docker run exit', code, sig); setTimeout(() => console.log('after:', ps()), 1000); });
```

```
$ node host.mjs q26-agent:distroless roundtrip
<- {"type":"tool_call","id":1,"tool":"echo","args":{"text":"hello"}}
<- {"type":"tool_call","id":2,"tool":"fetch_url","args":{"url":"https://example.com/"}}
<- {"type":"tool_call","id":3,"tool":"denied_tool","args":{}}
<- {"type":"result","result":{"a":{"text":"hello"},"b_status":200,"c_error":"tool_not_allowed"},"cost":{"tokens":0}}
docker run exit 0 null      after: (gone)          # 컨테이너 기동~종료 0.5~1.9초
$ node host.mjs q26-agent:distroless hang 3000 docker-kill
time limit exceeded -> docker-kill | before: Up 2 seconds
docker run exit 137 null    after: (gone)
$ node host.mjs q26-agent:distroless hang 3000 close-stdin
docker run exit 3 null      after: (gone)          # 협조적 에이전트는 stdin EOF로 종료
$ node host.mjs q26-agent:distroless hostile 3000 sigkill-cli
docker run exit null SIGKILL    after: Up 3 seconds
5s after CLI SIGKILL: Up 7 seconds                  # CLI 프로세스를 죽여도 컨테이너는 계속 돈다
```

- **취소·시간 제한은 반드시 `docker kill <이름>`으로 한다.** `docker run` CLI 프로세스를 죽이는 것(데몬 비정상 종료 포함)은 컨테이너를 멈추지 않는다. 협조적 에이전트는 stdin EOF로 끝나지만 적대적 에이전트는 무시할 수 있다.
- **고아 정리:** 컨테이너에 run 식별 라벨을 붙이고, 데몬 시작 시 라벨로 남은 컨테이너를 죽인다. 실측: CLI만 SIGKILL한 뒤 `docker ps -q --filter label=aot.q26=1` → 1개, `xargs docker kill` 후 0개.
- `--log-driver none`에서도 attach 왕복이 동작했다. 기본 로그 드라이버는 stdio 프레임(도구 결과 포함)을 Docker 쪽 로그 파일에 남기므로 끈다.

## 4. 최소 권한 플래그와 위반 시도 (기준 4)

`$H`에서 `--user`만 바꿔 셸 스크립트를 stdin으로 넘겼다(`docker run $H --entrypoint sh $IMG -s < probe-priv.sh`). 대조군은 강화 플래그 없이 `--network none --user 1000:1000`만 준 실행이다.

| 플래그 | 위반 시도 | 강화 (비루트 1000) | 강화 + `--user 0` | 대조군 |
|---|---|---|---|---|
| `--user 1000:1000` | `id` | uid=1000 | uid=0 | uid=1000 |
| `--read-only` | `/etc`·`/usr/local/bin`에 쓰기 | `Read-only file system` | `Read-only file system` | 권한 오류(파일시스템은 쓰기 가능) |
| `--cap-drop ALL` | `/proc/self/status` | CapEff 0, CapBnd 0 | CapEff 0, CapBnd 0 | CapBnd `a80425fb` |
| `--cap-drop ALL` | 루트가 1000 소유 0700 `/work`에 쓰기, `mknod` | — | `Permission denied`(DAC override 없음), `mknod` 실패 | — |
| `--security-opt no-new-privileges` | setuid 바이너리로 `/etc/shadow` 읽기(`passwd -S node`) | NoNewPrivs 1, `node P`(shadow 못 읽음) | — | NoNewPrivs 0, `node L 2026-…`(**setuid로 읽음**) |
| tmpfs `noexec` | `/work`에 복사한 `/bin/true` 실행 | `Permission denied`(126) | 실행 불가 | Docker 기본 tmpfs도 noexec |
| tmpfs `size=16m` | 32MB 쓰기 | `No space left on device` | — | 32MB 기록됨 |
| `--memory 128m --memory-swap 128m` | 300MB 할당 | 종료 137, `OOMKilled=true` | — | — |
| `--cpus 0.5` | 4초 바쁜 루프 | cpu/wall 0.54, `nr_throttled 41`, `cpu.max=50000 100000` | — | `cpu.max=max` |
| `--pids-limit 32` | 자식 60개 생성 | 25개 생성, 35개 `EAGAIN`, `pids.current 32` | — | 60개 생성(`pids.current 62`) |

```sh
# probe-priv.sh (발췌): 각 줄의 오류 메시지가 위 표의 값
id; grep -E '^(CapEff|CapBnd|NoNewPrivs|Seccomp):' /proc/self/status
echo x > /etc/q26; echo x > /usr/local/bin/q26; echo ok > /work/f
cp /bin/true /work/t && /work/t; dd if=/dev/zero of=/work/big bs=1M count=32
chown 0:0 /work/f; mknod /work/dev c 1 3; passwd -S node
cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max
# 메모리
docker run $H --rm=false --name q26-oom $IMG node -e 'const a=[];for(let i=0;i<30;i++)a.push(Buffer.alloc(10<<20,1))'
docker inspect q26-oom --format 'OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}}'; docker rm q26-oom
# CPU
docker run $H $IMG node -e 'const t=Date.now();while(Date.now()-t<4000){}const u=process.cpuUsage();console.log((u.user+u.system)/1000/4000)'
# pids
docker run $H $IMG node -e 'const {spawn}=require("child_process");let ok=0,e=0,n=60;
for(let i=0;i<60;i++){const c=spawn("sleep",["30"]);c.on("spawn",()=>{ok++;d()});c.on("error",()=>{e++;d()})}
function d(){if(--n)return;console.log(ok,e,require("fs").readFileSync("/sys/fs/cgroup/pids.current","utf8"));process.exit(0)}'
```

주의(실측에서 걸린 것):
- `--tmpfs`는 기본으로 root 소유 755다. 비루트 사용자가 쓰려면 `uid=…,gid=…,mode=0700`을 준다.
- Dockerfile `COPY --chmod=0444`는 새로 만드는 상위 디렉터리에도 0444를 적용해 비루트가 파일을 못 읽었다. `COPY --chown=0:0`만 쓰고(파일 0644) 읽기 전용 루트로 쓰기를 막는다.
- `/dev/shm`은 `--ipc none`으로 없앤다.

## 5. 데몬에서 Docker 호출 (기준 5)

| 방법 | 실측 | 의존성 | 평가 |
|---|---|---|---|
| `docker` CLI를 `child_process.spawn`(셸 없음, 인자 배열) | §3 전체가 이 방식 | 없음 (CLI 바이너리 필요) | **채택.** stdio attach·`kill`·라벨 조회가 CLI 한 줄씩이다 |
| Engine API(`node:http`, `socketPath`) | `GET /version` 200(API 1.55), `GET /containers/json?filters=label` 200 | 없음 | 가능하지만 attach가 HTTP 업그레이드 + stdout/stderr 다중화 프레임 해석을 요구해 코드가 늘어난다. 상태 조회 보조용으로만 고려 |

- CLI 경로는 설정값의 절대 경로로 고정하고(`PATH` 탐색 금지), `DOCKER_HOST`·`DOCKER_CONTEXT` 등 환경 변수는 데몬이 명시한 값만 넘긴다. 인자는 데몬이 고정 템플릿으로 만들고 업무 명세의 값을 플래그 위치에 넣지 않는다.
- **권한 위험.** Docker 소켓에 접근할 수 있으면 `--privileged`·호스트 경로 마운트로 컨테이너를 띄울 수 있으므로 사실상 root(macOS에서는 Docker VM의 root + 파일 공유 범위의 사용자 파일)와 같다.
  - macOS Docker Desktop: 소켓이 로그인 사용자 소유(사용자 홈의 `.docker/run/docker.sock`, srwxr-xr-x)라 데몬 사용자가 곧 Docker 관리자다(실측).
  - Linux(실측 안 함): `docker` 그룹 = root 동등. 데몬 사용자만 그룹에 넣고 에이전트 컨테이너에는 소켓을 절대 마운트하지 않는다. rootless Docker·Podman은 위험을 줄이는 대안이지만 시험하지 않았다.
  - 에이전트는 컨테이너 안에만 있으므로 Docker 소켓에 닿지 않는다(§1에서 `/var/run/docker.sock` ENOENT). 위험은 "데몬 프로세스가 탈취되면"의 크기를 키우는 쪽이다.

## 6. 이미지 (기준 6)

| 후보 | 기준 이미지 (인덱스 digest) | Node | 사용자 | 셸 | 크기(로컬) |
|---|---|---|---|---|---|
| **A (채택)** | `gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a` | 24.14.0 | 65532 | 없음 | 211MB |
| B (대체·디버그용) | `node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205` | 24.22.1 | 1000 | 있음, setuid 바이너리 8개 | 349MB |

```dockerfile
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
COPY --chown=0:0 agent.js /opt/agent/agent.js
USER 65532:65532
WORKDIR /work
ENTRYPOINT ["/nodejs/bin/node", "/opt/agent/agent.js"]
```

```sh
docker build -q -f Dockerfile.distroless -t q26-agent:distroless .     # 후보 B는 FROM·USER·ENTRYPOINT만 바꾼다
docker buildx imagetools inspect gcr.io/distroless/nodejs24-debian12:nonroot   # 인덱스에 linux/amd64, linux/arm64/v8
```

- 선택 이유: 셸·패키지 관리자·setuid 바이너리가 없어 위반 시도의 도구 자체가 없다. Phase A의 실제 어댑터(읽기 전용 조사 에이전트)는 우리 Node 코드라 셸이 필요 없다.
- 고정: `FROM`은 다중 아키텍처 **인덱스 digest**로 고정한다. 데몬은 빌드 결과의 이미지 ID(`sha256:…`)를 설정에 두고 그 ID로만 실행한다(태그로 실행하지 않음). 기준 이미지 갱신은 digest 변경 커밋으로 한다.
- 약점: distroless의 Node(24.14.0)가 slim(24.22.1)보다 뒤처져 있었다. 보안 패치 반영이 늦을 수 있으므로 갱신 주기를 운영 항목으로 둔다. 셸이 필요한 에이전트 제품(코드 에이전트, Q4)은 후보 B 기반 별도 이미지로 따로 정한다.
- 이미지 사용자(65532)는 데몬 사용자의 UID와 다르게 둔다. Linux에서 실수로 마운트했을 때 호스트 파일 권한이 적용되게 하기 위해서다(Linux 실측 안 함).

## 7. A3 편차 판단 (기준 7)

- 컨테이너에서 `instance/run/approval.sock`, `instance/totp/owner.secret`, DB, `policies/`는 모두 ENOENT(§1). 네트워크가 없어 호스트의 다른 경로로도 닿지 않는다(§2). 따라서 "에이전트 프로세스가 승인 소켓·TOTP 비밀·DB에 도달할 수 없다"는 요건(trust-boundaries §3.1-1·2)은 **에이전트를 이 방식의 컨테이너 안에서만 실행하는 한 충족**된다.
- 피어 UID 확인(네이티브 애드온)은 넣지 않는다. 승인 채널의 사람 확인은 기존대로 소켓 파일 권한 + 위험 변경 TOTP가 맡는다.
- 다만 §1 대조군처럼 **한 번이라도 잘못 마운트하면 파일 권한이 보호하지 못한다**(macOS). 그래서 해소의 조건은 "마운트 0개"를 코드와 시험으로 고정하는 것이다.

## 남은 위험

1. **마운트 실수가 곧 노출이다.** Docker Desktop은 바인드 마운트에 호스트 권한을 적용하지 않는다(실측). A5에서 컨테이너 인자 생성기를 한 곳에 두고 `-v`/`--mount`/`--volumes-from`/`--privileged`/`--network` 값 변경/`--cap-add`/`--device`를 거부하는 단위 시험, 실행 후 `docker inspect`의 `Mounts`가 비었는지 확인하는 OS 수준 시험을 둔다.
2. **에이전트가 호스트에서 돌면 무효다.** 같은 UID 문제(trust-boundaries §3.1)는 그대로 남는다. Docker를 쓸 수 없을 때 호스트 실행으로 대체하는 경로를 만들지 않는다.
3. **Docker 소켓 = root 동등.** 데몬 프로세스 탈취 시 피해가 커진다(§5). 사람 결정 필요: Linux 배포에서 rootful + `docker` 그룹을 받아들일지, rootless Docker/Podman을 요구할지.
4. **stdout 오염·프레임 크기.** 에이전트 제품이 stdout에 아무 글이나 쓰면 프레임이 깨진다. 컨테이너 PID 1을 우리 shim으로 두고 에이전트 제품의 stdout은 stderr로 돌리는 것, 호스트가 프레임 최대 크기·형식 오류 시 즉시 `docker kill`하는 것은 A5 구현 항목이다(미구현·미실측).
5. **HTTP를 직접 쓰는 에이전트 제품.** 모델 API 호출도 게이트웨이를 거쳐야 하므로(비밀값은 호스트의 도구 어댑터가 주입) 컨테이너 안 루프백 shim이 필요하다. Phase A의 읽기 전용 조사 에이전트는 도구 호출 프레임만 쓰면 되므로 선행 조건은 아니다.
6. **Linux 미실측.** `--network none`·cgroup 제한·`no-new-privileges`는 커널 기능이라 같게 동작할 것으로 보지만, 바인드 마운트 권한(Linux는 호스트 UID·권한이 그대로 적용), 소켓 마운트 동작, `host-gateway`는 다르다. CI(Linux)에서 OS 수준 시험을 돌려 확인한다.
7. **컨테이너 기동 비용.** 실행마다 0.5~1.9초(이 환경). 업무 단위 실행에는 문제없지만 도구 호출마다 컨테이너를 띄우는 설계는 피한다.
8. **커널 공유.** 컨테이너는 VM이 아니다. 커널 취약점은 이 격리로 막지 못한다(seccomp 기본 프로필은 켜져 있음: `Seccomp: 2`).

## 사용 버전

Docker Desktop 29.6.2 (Engine API 1.55, linux/arm64, cgroup v2), docker CLI 29.6.2, 호스트 Node 24.22.0, 이미지 digest는 §6. macOS arm64.
