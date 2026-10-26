// A5 U5: 조사 에이전트 이미지의 정적 점검 (docker 불필요). 컨테이너에는 의존성이 없으므로 에이전트 코드가 쓰는 import 가 이미지에 들어가는 파일 안에서 닫혀 있어야 하고,
// 에이전트가 파일·네트워크·자식 프로세스·환경 변수에 닿는 API 를 쓰지 않으며, 도구 이름이 리터럴 하나뿐이어야 한다.
// Dockerfile 의 기준 이미지 digest 는 U3 의 시험용 이미지와 같아야 한다(기준 이미지를 한 곳에서 갱신하기 위해).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { describe, it } from 'node:test';

import { AGENT_RUNTIME_DIR, RESEARCH_AGENT_DIR, RESEARCH_AGENT_IMAGE_FILES } from '../support/research-agent.ts';

const read = (path: string): string => readFileSync(join(AGENT_RUNTIME_DIR, path), 'utf8');
const TS_FILES = RESEARCH_AGENT_IMAGE_FILES.filter((file) => file.endsWith('.ts'));

/** `import … from '…'`, `export … from '…'`, `import '…'`, `import('…')` 의 지정자 (주석 제거 후) */
function specifiersOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  for (const match of code.matchAll(/(?:^|\s)(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|\s)import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push((match[1] ?? match[2] ?? match[3])!);
  }
  return out;
}

/** 타입만 가져오는 import 는 타입 제거 때 사라진다 */
function runtimeSpecifiersOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const typeOnly = [...code.matchAll(/(?:^|\s)import\s+type\s[^;]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
  const all = specifiersOf(source);
  for (const spec of typeOnly) all.splice(all.indexOf(spec), 1);
  return all;
}

describe('research agent image: the runtime import graph is closed inside the image', () => {
  it('every runtime import is a node: builtin or a relative file that the Dockerfile copies', () => {
    for (const file of TS_FILES) {
      for (const spec of runtimeSpecifiersOf(read(file))) {
        if (spec.startsWith('node:')) continue;
        assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${file}: '${spec}' is a bare specifier; the image has no node_modules`);
        const target = normalize(join(dirname(file), spec));
        assert.ok(RESEARCH_AGENT_IMAGE_FILES.includes(target), `${file}: imports ${target}, which is not in the image`);
      }
    }
  });

  it('the shared modules have no imports other than node: builtins (wire.ts has none at all)', () => {
    assert.deepEqual(specifiersOf(read('src/wire.ts')), []);
    assert.deepEqual(specifiersOf(read('src/line-reader.ts')), ['node:buffer']);
  });

  it('the Dockerfile copies exactly the listed files, to the same relative paths, and starts the agent entry', () => {
    const dockerfile = read('container/research-agent/Dockerfile');
    const copied: string[] = [];
    for (const line of dockerfile.split('\n')) {
      const match = /^COPY\s+--chown=0:0\s+(.+?)\s+(\S+)$/.exec(line);
      if (!match) continue;
      const sources = match[1]!.split(/\s+/);
      const destination = match[2]!;
      for (const source of sources) {
        const target = destination.endsWith('/') ? `${destination}${source.split('/').pop()}` : destination;
        const relativeTarget = relative('/opt/agent', target);
        copied.push(`${source}=>${relativeTarget}`);
        if (source.endsWith('image-package.json')) assert.equal(relativeTarget, 'package.json');
        else assert.equal(relativeTarget, source, `${source} keeps its repository-relative path in the image`);
      }
    }
    const expected = RESEARCH_AGENT_IMAGE_FILES.filter((file) => !file.endsWith('/Dockerfile')).sort();
    assert.deepEqual(copied.map((entry) => entry.split('=>')[0]!).sort(), expected);
    for (const file of RESEARCH_AGENT_IMAGE_FILES) assert.ok(existsSync(join(AGENT_RUNTIME_DIR, file)), file);
    assert.match(dockerfile, /^USER 65532:65532$/m);
    assert.match(dockerfile, /^ENTRYPOINT \["\/nodejs\/bin\/node", "\/opt\/agent\/container\/research-agent\/agent\.ts"\]$/m);
    assert.ok(!/^\s*(RUN|ADD|ENV|EXPOSE|VOLUME)\b/m.test(dockerfile), 'no RUN/ADD/ENV/EXPOSE/VOLUME: the image only carries the copied files');
    assert.equal(JSON.parse(read('container/research-agent/image-package.json')).type, 'module');
  });

  it('uses the same digest-pinned base image as the U3 test agent image', () => {
    const digestOf = (text: string): string | undefined => /^FROM (\S+@sha256:[0-9a-f]{64})$/m.exec(text)?.[1];
    const research = digestOf(read('container/research-agent/Dockerfile'));
    const fixture = digestOf(readFileSync(join(AGENT_RUNTIME_DIR, '..', '..', 'test', 'fixtures', 'container-agent', 'Dockerfile'), 'utf8'));
    assert.ok(research !== undefined, 'FROM must be pinned by digest');
    assert.equal(research, fixture);
  });
});

describe('research agent code: no way to reach anything but the gateway', () => {
  const sources = Object.fromEntries(['agent.ts', 'core.ts'].map((name) => [name, read(`container/research-agent/${name}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')]));

  it('does not use files, sockets, HTTP, child processes, environment variables, dynamic code or the global fetch', () => {
    const forbidden = [
      /node:(fs|net|http|https|http2|dns|child_process|worker_threads|cluster|vm|tls|dgram|os|module|inspector)/, /\bprocess\.env\b/, /\bprocess\.binding\b/, /\bprocess\.dlopen\b/,
      /\bfetch\s*\(/, /\beval\s*\(/, /\bnew Function\b/, /\bimport\s*\(/, /\brequire\s*\(/, /\bglobalThis\b/, /\bWebSocket\b/, /\bXMLHttpRequest\b/,
    ];
    for (const [name, code] of Object.entries(sources)) for (const pattern of forbidden) assert.ok(!pattern.test(code), `${name} must not use ${String(pattern)}`);
  });

  it('agent.ts names exactly one tool, through the FETCH_TOOL constant, and no tool name is built at run time', () => {
    const agent = sources['agent.ts']!;
    const core = sources['core.ts']!;
    assert.match(core, /export const FETCH_TOOL = 'fetch_url';/);
    const calls = [...agent.matchAll(/\bcall\(\s*([^,)]*)/g)].map((m) => m[1]!.trim()).filter((arg) => !arg.startsWith('tool: string'));
    assert.deepEqual(calls, ['FETCH_TOOL'], 'the only call() site passes the constant');
    assert.deepEqual([...agent.matchAll(/type:\s*'tool_call'/g)].length, 1, 'tool_call frames are built in one place (call())');
    assert.ok(!/'fetch_url'|"fetch_url"/.test(agent), 'the tool name literal lives only in core.ts');
    // 코어는 도구를 이름으로 부르지 못한다: 게이트웨이로 나가는 길은 주입된 fetchUrl 하나다
    assert.deepEqual([...core.matchAll(/deps\.(\w+)\(/g)].map((m) => m[1]).filter((name, i, all) => all.indexOf(name) === i).sort(), ['fetchUrl', 'log', 'now', 'reportCost']);
    assert.deepEqual([...core.matchAll(/deps\.fetchUrl\(([^)]*)\)/g)].map((m) => m[1]), ['source.url'], 'fetchUrl is only ever called with a source URL taken from the task_spec');
  });

  it('page text (the tool result) is not used to pick a tool, an argument or the next step', () => {
    const core = sources['core.ts']!;
    // 페이지에서 온 값은 pageOf() 가 만든 Page 의 필드다. 호출 인자(source.url)는 targets 에서만 온다.
    assert.ok(!/fetchUrl\([^)]*page\b/.test(core));
    assert.ok(!/fetchUrl\([^)]*\btext\b/.test(core));
    assert.ok(!/response\.result[^;\n]*fetchUrl/.test(core));
  });
});

describe('the research agent source stays under the container directory convention', () => {
  it('lives in packages/agent-runtime/container/research-agent and is not part of the public API', () => {
    assert.ok(existsSync(RESEARCH_AGENT_DIR));
    const index = read('src/index.ts');
    assert.ok(!/container\/research-agent/.test(index.replace(/\/\/.*$/gm, '')), 'the host never imports the container code');
  });
});
