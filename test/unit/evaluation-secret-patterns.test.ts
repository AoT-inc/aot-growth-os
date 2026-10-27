// 산출물 비밀값 모양 찾기(secret-patterns.ts). 호출 기록 마스킹(agent-runtime mask.ts)과 같은 집합인지 같은 표본으로 대조하고,
// 결과에 값이 나오지 않는지 확인한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { maskString } from '@aot/agent-runtime';
import { findSecretShapes } from '@aot/evaluation';

// 가상 값이다(실제 키가 아님). 모양만 맞춘다. 비밀 스캐너(push protection 포함)가 소스의 표본을 진짜 키로 오인하지 않도록 접두를 나눠 런타임에 이어 붙인다.
const join = (...parts: string[]): string => parts.join('');
const SAMPLES: [string, string][] = [
  ['private_key', join('-----BEGIN RSA PRIV', 'ATE KEY-----\nMIIEexample\n-----END RSA PRIV', 'ATE KEY-----')],
  ['bearer_token', 'Authorization: Bearer abcdefgh12345678'],
  ['url_credentials', join('origin = https:', '//deploy:hunter2example@git.example.com/repo.git')],
  ['query_secret', 'GET /download?token=abcdef0123456789&x=1'],
  ['jwt', join('ey', 'JhbGciOiJIUzI1NiJ9.', 'ey', 'JzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJlZXhhbXBsZQ')],
  ['api_key_prefix', join('key ', 'sk', '-exampleexampleexample0123')],
  ['github_token', join('gh', 'p_exampleexampleexample0123456789')],
  ['slack_token', join('xo', 'xb-1234567890-exampleexample')],
  ['aws_access_key', join('AK', 'IAEXAMPLEEXAMPLE12')],
];

test('every sample shape is found, and by exactly the kind it is named for', () => {
  for (const [kind, text] of SAMPLES) {
    assert.deepEqual(findSecretShapes(text).map((finding) => finding.kind), [kind], kind);
  }
});

test('parity with the call-log masking: a text is masked if and only if a shape is found', () => {
  const texts = [
    ...SAMPLES.map(([, text]) => text),
    'plain text with no secret at all',
    'see https://docs.example.com/guide?page=2 for details',
    'a sentence about a token in prose, and a key in a keyboard',
    'user@example.com wrote the readme',
  ];
  for (const text of texts) {
    assert.equal(maskString(text) !== text, findSecretShapes(text).length > 0, text);
  }
});

test('counts every occurrence and never returns the matched text', () => {
  const text = `a ${join('gh', 'p_exampleexampleexample0123456789')} b ${join('gh', 'p_exampleexampleexample9876543210')} c ${join('AK', 'IAEXAMPLEEXAMPLE12')}`;
  const found = findSecretShapes(text);
  assert.deepEqual(found, [{ kind: 'github_token', count: 2 }, { kind: 'aws_access_key', count: 1 }]);
  assert.ok(!JSON.stringify(found).includes('exampleexample'));
});

test('prose that merely mentions tokens, keys or passwords is not a finding', () => {
  assert.deepEqual(findSecretShapes('Set the password in your environment; the API key goes in a vault. Tokens expire.'), []);
});

// ----- 치환 문법(자리표시자)은 값이 아니다 -----
const PLACEHOLDER_PASSWORDS = ['${POSTGRES_PASSWORD}', '${db_password}', '${db.password}', '$DB_PASSWORD', '<password>', '<YOUR_DB-PASSWORD>', '{{db_password}}', '{db_password}', '%(password)s', '%DB_PASSWORD%'];
// 값일 수 있는 것: 기본값을 품은 치환, 리터럴이 섞인 것, 숫자·소문자가 섞인 `$` 값, 숫자가 든 꺾쇠 값
const VALUE_LIKE_PASSWORDS = ['${PASS:-hunter2}', '${PASS}hunter2', 'pa${X}ss', '$hunter2', '$ecret', '<hunter2>', 'hunter2', '$HUNTER2', '$HUNTER', '${Tr0ub4dor}', '<hunter>', '{hunter}', '%hunter%', '{{hunter}}', '%(hunter)s', '${}', '$', '${A B}'];

test('a placeholder in the password slot of a URL is not a credential, in the finder and in the masker alike', () => {
  for (const placeholder of PLACEHOLDER_PASSWORDS) {
    const text = join('postgresql+psycopg:', `//\${POSTGRES_USER}:${placeholder}@db.example.com:5432/app`);
    assert.deepEqual(findSecretShapes(text), [], placeholder);
    assert.equal(maskString(text), text, `masking leaves the placeholder visible: ${placeholder}`);
  }
});

test('a value-like password stays a finding and is masked, even when the user part is a placeholder', () => {
  for (const value of VALUE_LIKE_PASSWORDS) {
    const text = join('postgres:', `//\${POSTGRES_USER}:${value}@db.example.com/app`);
    if (value === '${}' || value === '$' || value === '${A B}') {
      // 문법이 아닌 조각은 어느 쪽이든 두 구현이 같은 판정을 한다
      assert.equal(maskString(text) !== text, findSecretShapes(text).length > 0, value);
      continue;
    }
    assert.deepEqual(findSecretShapes(text).map((finding) => finding.kind), ['url_credentials'], value);
    assert.notEqual(maskString(text), text, value);
  }
});

test('the user slot counts too: a plain name or a placeholder keeps the exemption, an opaque token as the user does not', () => {
  const url = (user: string): string => join('https:', `//${user}:\${DB_PASSWORD}@git.example.com/r.git`);
  for (const user of ['deploy', 'admin01', 'ci-bot', 'svc_account', '${GIT_USER}', '$GIT_USER']) {
    assert.deepEqual(findSecretShapes(url(user)), [], user);
    assert.equal(maskString(url(user)), url(user), user);
  }
  for (const user of ['Ab12Cd34Ef56Gh78Ij90', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8', 'user:extra']) {
    // 어느 모양이든 두 구현(검사와 마스킹)이 같은 판정을 한다
    assert.equal(maskString(url(user)) !== url(user), findSecretShapes(url(user)).length > 0, user);
  }
  for (const user of ['Ab12Cd34Ef56Gh78Ij90', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8']) {
    assert.deepEqual(findSecretShapes(url(user)).map((finding) => finding.kind), ['url_credentials'], user);
    assert.notEqual(maskString(url(user)), url(user), user);
  }
});

test('the same holds for query values: ?token=${TOKEN} is a reference, ?token=${TOKEN:-abc123} is not', () => {
  assert.deepEqual(findSecretShapes('curl https://api.example.com/v1?token=${API_TOKEN}&x=1'), []);
  assert.equal(maskString('https://api.example.com/v1?token=${API_TOKEN}'), 'https://api.example.com/v1?token=${API_TOKEN}');
  assert.deepEqual(findSecretShapes('https://api.example.com/v1?token=${API_TOKEN:-abc123}').map((finding) => finding.kind), ['query_secret']);
  for (const value of ['$ABC', '$HUNTER2', '{hunter}']) assert.deepEqual(findSecretShapes(`https://api.example.com/v1?token=${value}`).map((finding) => finding.kind), ['query_secret'], value);
  assert.notEqual(maskString('https://api.example.com/v1?token=${API_TOKEN:-abc123}'), 'https://api.example.com/v1?token=${API_TOKEN:-abc123}');
});

test('parity fuzz: for generated passwords, users and query values the finder and the masker always agree', () => {
  const pieces = ['$', '${', '}', '{', '}}', '<', '>', '%', '(', ')s', 'DB_PASSWORD', 'PASS', 'pass', 'hunter', 'Hunter2', 'a1', ':-', '.', '-', '_', 'x'];
  let seed = 12345;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  const gen = (): string => Array.from({ length: 1 + (next() % 5) }, () => pieces[next() % pieces.length]!).join('');
  for (let i = 0; i < 4000; i += 1) {
    const text = `${join('x: https:', '//')}${gen().replace(/[:@/\s]/g, '')}:${gen().replace(/[@/\s]/g, '')}@h.example.com and https://a.example.com/p?key=${gen().replace(/[&\s#]/g, '')}`;
    assert.equal(maskString(text) !== text, findSecretShapes(text).length > 0, text);
  }
});

test('one placeholder next to one real credential counts only the real one', () => {
  const text = `${join('a: https:', '//ci:${CI_PASSWORD}@x.example.com')} and ${join('b: https:', '//ci:realpassword@y.example.com')}`;
  assert.deepEqual(findSecretShapes(text), [{ kind: 'url_credentials', count: 1 }]);
});
