// 시험용 가짜 컨테이너 에이전트 (스파이크 Q26 §3 의 agent.js 를 U1 프레임 형식에 맞춘 것). 모델·실제 네트워크를 쓰지 않는다.
// 인자: roundtrip | hang | hostile | probe <path>... | garbage | flood
//   roundtrip  start 를 받고 도구 호출 3건(허용 2, 허용 밖 1)을 왕복한 뒤 result 를 낸다
//   hang       도구 호출 1건 뒤 멈춘다. stdin EOF 를 받으면 종료한다(협조적)
//   hostile    hang 과 같지만 stdin EOF 를 무시한다
//   probe      컨테이너 안에서 본 것(경로 존재, 쓰기, 네트워크, 사용자)을 result 로 보고한다
//   garbage    프레임이 아닌 줄을 stdout 에 쓴다
//   flood      개행 없이 stdout 에 계속 쓴다
// stdout 은 프레임 전용이다. 로그는 stderr 로 쓴다.
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import readline from 'node:readline';
import { setInterval } from 'node:timers';

const mode = process.argv[2] || 'roundtrip';
const rl = readline.createInterface({ input: process.stdin });
const pending = new Map();
let nextId = 1;
let startFrame = null;
let resolveStart;
const started = new Promise((resolve) => { resolveStart = resolve; });

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const call = (tool, args) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  send({ type: 'tool_call', id, tool, args });
});
const result = (body, cost) => ({
  type: 'result', status: 'submitted', result: body, evidence: [],
  run_log: [{ at: new Date().toISOString(), message: `fixture agent (${mode}) finished` }], cost,
});

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'start') {
    startFrame = message;
    resolveStart();
    return;
  }
  const waiter = pending.get(message.id);
  pending.delete(message.id);
  if (waiter) waiter(message);
});
rl.on('close', () => {
  if (mode !== 'hostile') process.exit(3);
  process.stderr.write('stdin closed; ignoring\n');
});

const stat = (path) => {
  try { fs.statSync(path); return 'VISIBLE'; } catch (error) { return error.code; }
};
const writeProbe = (path) => {
  try { fs.writeFileSync(path, 'x'); fs.unlinkSync(path); return 'WRITABLE'; } catch (error) { return error.code; }
};
const connect = (host, port) => new Promise((resolve) => {
  const socket = net.connect({ host, port, timeout: 3000 });
  socket.on('connect', () => { socket.destroy(); resolve('CONNECTED'); });
  socket.on('timeout', () => { socket.destroy(); resolve('TIMEOUT'); });
  socket.on('error', (error) => resolve(error.code || 'ERROR'));
});
const lookup = (host) => new Promise((resolve) => dns.lookup(host, (error) => resolve(error ? error.code : 'RESOLVED')));

await started;
{
  if (mode === 'roundtrip') {
    send({ type: 'cost_progress', cumulative: 0.005, unit: 'usd' });
    const a = await call('echo', { text: 'hello' });
    const b = await call('fetch_url', { url: 'https://example.com/' });
    const c = await call('denied_tool', {});
    send(result({
      a: a.result, b_status: b.result && b.result.status, c_error: c.error,
      start: { run_id: startFrame.run_id, tools: startFrame.allowed_tools.map((t) => t.tool), max_usd: startFrame.budget.max_usd, objective: startFrame.task_spec.objective },
    }, { usd: 0.01 }));
    process.exit(0);
  }
  if (mode === 'probe') {
    const paths = process.argv.slice(3);
    const seen = {};
    for (const path of paths) seen[path] = stat(path);
    const net_ = {
      dns_example_com: await lookup('example.com'),
      tcp_1_1_1_1_443: await connect('1.1.1.1', 443),
      tcp_8_8_8_8_53: await connect('8.8.8.8', 53),
      tcp_host_docker_internal_80: await connect('host.docker.internal', 80),
      tcp_example_com_443: await connect('example.com', 443),
    };
    send(result({
      uid: process.getuid(), gid: process.getgid(), seen, net: net_,
      canary: { agent_file: stat('/opt/agent/agent.mjs'), work_dir: stat('/work') },
      writes: { root_fs: writeProbe('/opt/agent/probe.tmp'), work_tmpfs: writeProbe('/work/probe.tmp') },
      env_names: Object.keys(process.env).sort(),
    }, { usd: 0 }));
    process.exit(0);
  }
  if (mode === 'garbage') {
    process.stdout.write('this is not a frame\n');
    setInterval(() => {}, 1 << 30);
  } else if (mode === 'flood') {
    const chunk = 'x'.repeat(64 * 1024);
    setInterval(() => { for (let i = 0; i < 64; i++) process.stdout.write(chunk); }, 5);
  } else {
    // hang, hostile
    await call('echo', { text: 'before-hang' });
    setInterval(() => {}, 1 << 30);
  }
}
