// A5 U3: 컨테이너 인자 생성기 (스파이크 Q26 §3·§4, "남은 위험 1"). 고정 템플릿, 마운트 0개, 위험 플래그·태그 이미지·이상한 이름 거부.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildContainerArgs, ContainerArgsError, DEFAULT_CONTAINER_USER, forbiddenFlagIn, type ContainerArgsErrorCode, type ContainerConfig,
} from '@aot/agent-runtime';

const IMAGE = `sha256:${'ab12'.repeat(16)}`;

function config(overrides: Record<string, unknown> = {}): ContainerConfig {
  return {
    image: IMAGE, name: 'aot-run-run-1', runId: 'run-1', instance: 'inst-1',
    limits: { memoryMiB: 128, cpus: 0.5, pidsLimit: 32, tmpfsMiB: 16 },
    ...overrides,
  } as ContainerConfig;
}

function rejects(overrides: Record<string, unknown>, code: ContainerArgsErrorCode): void {
  assert.throws(() => buildContainerArgs(config(overrides)), (error: unknown) => error instanceof ContainerArgsError && error.code === code, `expected ${code} for ${JSON.stringify(overrides)}`);
}

/** `flag` 다음 값(들)을 돌려준다. 이미지 앞의 인자만 본다 */
function valueOf(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

describe('buildContainerArgs: the fixed template', () => {
  it('always contains every hardening flag of the spike, with the configured limits', () => {
    const args = buildContainerArgs(config());
    assert.equal(args[0], 'run');
    for (const flag of ['--rm', '-i', '--read-only']) assert.ok(args.includes(flag), flag);
    assert.equal(valueOf(args, '--network'), 'none');
    assert.equal(valueOf(args, '--cap-drop'), 'ALL');
    assert.equal(valueOf(args, '--security-opt'), 'no-new-privileges');
    assert.equal(valueOf(args, '--tmpfs'), '/work:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700');
    assert.equal(valueOf(args, '--workdir'), '/work');
    assert.equal(valueOf(args, '--memory'), '128m');
    assert.equal(valueOf(args, '--memory-swap'), '128m', 'swap equals memory: no swap');
    assert.equal(valueOf(args, '--cpus'), '0.5');
    assert.equal(valueOf(args, '--pids-limit'), '32');
    assert.equal(valueOf(args, '--ipc'), 'none');
    assert.equal(valueOf(args, '--log-driver'), 'none');
    assert.equal(valueOf(args, '--user'), `${DEFAULT_CONTAINER_USER.uid}:${DEFAULT_CONTAINER_USER.gid}`);
    assert.equal(valueOf(args, '--label'), 'aot.run=run-1');
    const labels = args.flatMap((arg, at) => (arg === '--label' ? [args[at + 1]] : []));
    assert.deepEqual(labels, ['aot.run=run-1', 'aot.instance=inst-1'], 'both the run label and the instance label are set (orphan cleanup selects by both)');
    assert.equal(valueOf(args, '--name'), 'aot-run-run-1');
    assert.equal(valueOf(args, '--pull'), 'never', 'never reaches for a registry');
  });

  it('opens no mount, volume, environment variable, privilege, device or published port', () => {
    const args = buildContainerArgs(config({ agentArgs: ['roundtrip'] }));
    const beforeImage = args.slice(0, args.indexOf(IMAGE));
    for (const flag of ['-v', '--volume', '--mount', '--volumes-from', '--privileged', '--cap-add', '--device', '--env', '-e', '--env-file', '--entrypoint', '-p', '--publish', '--pid', '--userns', '--add-host']) {
      assert.ok(!beforeImage.includes(flag), `${flag} must not be in the template`);
    }
    assert.ok(!beforeImage.some((arg) => arg.startsWith('--volume=') || arg.startsWith('--mount=') || arg.startsWith('--env=')));
    assert.equal(args.filter((arg) => arg === '--tmpfs').length, 1, 'the only filesystem added is the /work tmpfs');
  });

  it('puts the image (an ID) right before the agent arguments, which come last', () => {
    const args = buildContainerArgs(config({ agentArgs: ['probe', '/tmp/x'] }));
    assert.deepEqual(args.slice(-3), [IMAGE, 'probe', '/tmp/x']);
    assert.equal(args.indexOf(IMAGE), args.length - 3);
    assert.deepEqual(buildContainerArgs(config()).slice(-1), [IMAGE]);
  });

  it('is deterministic and does not read the process environment or task input', () => {
    assert.deepEqual(buildContainerArgs(config()), buildContainerArgs(config()));
    const args = buildContainerArgs(config({ user: { uid: 2000, gid: 3000 } }));
    assert.equal(valueOf(args, '--user'), '2000:3000');
    assert.match(valueOf(args, '--tmpfs') ?? '', /uid=2000,gid=3000/);
  });
});

describe('buildContainerArgs: forbidden configuration', () => {
  it('rejects every dangerous docker flag given as a config field, with the flag named', () => {
    const fields: Record<string, unknown> = {
      volumes: ['/x:/y'], volume: '/x:/y', mounts: ['type=bind,src=/x,dst=/y'], mount: 'type=bind', volumesFrom: 'other', privileged: true,
      capAdd: ['SYS_ADMIN'], device: '/dev/sda', pid: 'host', userns: 'host', env: { A: 'b' }, envFile: '/x', entrypoint: 'sh', addHost: 'a:1.1.1.1', publish: '80:80',
    };
    for (const [key, value] of Object.entries(fields)) rejects({ [key]: value }, 'forbidden_config_field');
    assert.throws(() => buildContainerArgs(config({ privileged: true })), /--privileged/);
  });

  it('allows --network and --security-opt only with the fixed values', () => {
    assert.ok(buildContainerArgs(config({ network: 'none', securityOpt: ['no-new-privileges'] })).length > 0);
    for (const network of ['host', 'bridge', 'container:other', '']) rejects({ network }, 'forbidden_flag');
    for (const securityOpt of [['seccomp=unconfined'], ['apparmor=unconfined'], ['no-new-privileges', 'seccomp=unconfined'], [], 'no-new-privileges']) rejects({ securityOpt }, 'forbidden_flag');
  });

  it('rejects root and non-integer users', () => {
    for (const user of [{ uid: 0, gid: 1000 }, { uid: 1000, gid: 0 }, { uid: 0, gid: 0 }, { uid: -1, gid: 5 }, { uid: 1.5, gid: 5 }, { uid: '1000', gid: 5 }, {}]) {
      rejects({ user }, 'invalid_user');
    }
    rejects({ user: { uid: 1000, gid: 1000, name: 'root' } }, 'forbidden_config_field');
  });

  it('rejects an image that is not an image ID: tags, names, digest references, empty values', () => {
    for (const image of [
      'node:24', 'node', 'node:latest', 'example-product/agent:1.0', '', 'sha256:abc', `sha256:${'z'.repeat(64)}`, `SHA256:${'a'.repeat(64)}`,
      `gcr.io/distroless/nodejs24-debian12@sha256:${'a'.repeat(64)}`, `${'a'.repeat(64)}`, ` sha256:${'a'.repeat(64)}`, `sha256:${'a'.repeat(64)} --privileged`,
    ]) {
      rejects({ image }, 'image_not_id');
    }
    for (const image of [undefined, null, 5, {}]) rejects({ image }, 'image_not_id');
  });

  it('rejects names and labels with characters outside letters, digits and _ . -', () => {
    for (const name of ['', 'a b', 'a/b', 'a:b', 'a=b', '-leading-dash', '.dot', 'name;rm', 'name\n', 'ü', 'a,b', 'x'.repeat(101)]) rejects({ name }, 'invalid_name');
    for (const runId of ['', 'a b', 'run=1', 'run,2', 'a/b', 'run\n1', '-x']) rejects({ runId }, 'invalid_label');
    assert.ok(buildContainerArgs(config({ name: 'A.b_c-1', runId: 'Run_1.a-b' })).length > 0);
  });

  it('requires a safe instance id (it becomes the aot.instance label that orphan cleanup filters on)', () => {
    for (const instance of ['', 'a b', 'i=1', 'i,2', 'a/b', 'i\n', '-x', '.x', 'x'.repeat(64), 'ü', undefined, null, 5]) rejects({ instance }, 'invalid_instance');
    assert.ok(buildContainerArgs(config({ instance: 'I.n_s-1' })).includes('aot.instance=I.n_s-1'));
    assert.ok(buildContainerArgs(config({ instance: 'x'.repeat(63) })).length > 0);
  });

  it('rejects limits outside the allowed range, including ones that would turn limits off', () => {
    const limits = { memoryMiB: 128, cpus: 0.5, pidsLimit: 32, tmpfsMiB: 16 };
    for (const bad of [{ memoryMiB: 0 }, { memoryMiB: -1 }, { memoryMiB: 8 }, { memoryMiB: 1.5 }, { memoryMiB: 1_000_000 }, { memoryMiB: '128' },
      { cpus: 0 }, { cpus: -1 }, { cpus: 100 }, { cpus: Number.NaN }, { cpus: 0.333 }, { pidsLimit: 0 }, { pidsLimit: -1 }, { pidsLimit: 1 }, { pidsLimit: 100_000 },
      { tmpfsMiB: 0 }, { tmpfsMiB: 100_000 }]) {
      rejects({ limits: { ...limits, ...bad } }, 'invalid_limit');
    }
    rejects({ limits: undefined }, 'invalid_limit');
    rejects({ limits: { ...limits, swap: -1 } }, 'forbidden_config_field');
  });

  it('rejects unknown top-level fields so nothing rides along unnoticed', () => {
    rejects({ extra: true }, 'forbidden_config_field');
    rejects({ labels: ['a=b'] }, 'forbidden_config_field');
  });
});

describe('buildContainerArgs: agent arguments', () => {
  const flagShapes = [
    ['-v', '/x:/y'], ['-v/x:/y'], ['--volume', '/x:/y'], ['--volume=/x:/y'], ['--mount', 'type=bind,src=/x,dst=/y'], ['--mount=type=bind'], ['--volumes-from', 'x'],
    ['--privileged'], ['--privileged=true'], ['--cap-add', 'ALL'], ['--cap-add=SYS_ADMIN'], ['--device', '/dev/kvm'], ['--device=/dev/kvm'],
    ['--network', 'host'], ['--network=host'], ['--net', 'host'], ['--pid', 'host'], ['--pid=host'], ['--userns', 'host'], ['--security-opt', 'seccomp=unconfined'],
    ['--security-opt=apparmor=unconfined'], ['--env', 'A=b'], ['--env=A=b'], ['-e', 'A=b'], ['-eA=b'], ['--env-file', '/x'], ['--user', 'root'], ['--user=0'], ['-u', '0'],
    ['--entrypoint', 'sh'], ['--entrypoint=sh'], ['-p', '80:80'], ['--publish=80:80'], ['--add-host=a:1.1.1.1'], ['--tmpfs', '/x'], ['--read-only=false'],
    ['--cap-drop', 'NONE'], ['--ipc', 'host'], ['--uts', 'host'], ['--runtime', 'runc'], ['--gpus', 'all'], ['--workdir', '/'], ['-w', '/'], ['--name', 'x'],
    ['--label', 'a=b'], ['--rm=false'], ['--pull', 'always'], ['--log-driver', 'json-file'], ['--memory', '0'], ['--pids-limit', '-1'], ['--cpus', '0'],
    ['-ti', '-v/x:/y'], ['-it', '-e', 'A=b'], ['-tv', '/x:/y'], ['--VOLUME=/x:/y'],
  ];

  it('rejects dangerous docker flags in every spelling (long, short, attached value, uppercase, cluster)', () => {
    for (const agentArgs of flagShapes) rejects({ agentArgs }, 'forbidden_flag');
  });

  it('forbiddenFlagIn names the flag and leaves ordinary values alone', () => {
    assert.equal(forbiddenFlagIn('--privileged'), 'privileged');
    assert.equal(forbiddenFlagIn('-v/x:/y'), 'v');
    assert.equal(forbiddenFlagIn('--Volume=/x'), 'volume');
    for (const fine of ['roundtrip', '/work/in.json', 'mode=fast', '--mode=fast', '--max-steps', '5', 'https://example.com/a?b=c', '-', '--', '-5']) {
      assert.equal(forbiddenFlagIn(fine), null, fine);
    }
  });

  it('accepts ordinary arguments, and places them after the image so docker never reads them as flags', () => {
    const args = buildContainerArgs(config({ agentArgs: ['--mode=fast', '--max-steps', '5', '/work/in.json'] }));
    assert.deepEqual(args.slice(args.indexOf(IMAGE)), [IMAGE, '--mode=fast', '--max-steps', '5', '/work/in.json']);
  });

  it('rejects arguments that are not plain printable tokens', () => {
    for (const bad of ['', 'two words', 'tab\there', 'new\nline', 'nul\0', 'ü', 'x'.repeat(513), 5, null, undefined, {}]) {
      rejects({ agentArgs: [bad] }, 'invalid_agent_arg');
    }
    rejects({ agentArgs: Array.from({ length: 33 }, () => 'a') }, 'invalid_agent_arg');
    rejects({ agentArgs: 'roundtrip' }, 'invalid_agent_arg');
  });

  it('never places task input in a flag position: the generator has no input for it, and agent args are inert after the image', () => {
    // 업무 명세의 값은 이 함수에 들어오지 않는다. 설정에 task_spec 를 넣으려 해도 알 수 없는 필드로 거부된다.
    rejects({ taskSpec: { objective: '--privileged' } }, 'forbidden_config_field');
    rejects({ task_spec: { objective: '-v /:/host' } }, 'forbidden_config_field');
  });
});
