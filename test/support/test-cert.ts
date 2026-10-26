// 시험 전용 자체서명 인증서 생성기 (A5 U6, fetch_url 의 https 정상 경로 시험용). 저장소에 인증서나 개인 키 파일을 두지 않는다:
// 시험이 돌 때마다 `node:crypto` 만으로 (openssl·외부 의존성 없이) 새 키쌍을 만들고 X.509 v3 인증서의 DER 을 직접 조립해 서명한다.
// 그래서 비밀값 스캔(gitleaks)에 걸릴 개인 키 문자열이 저장소에 없고, 만료·호스트 이름 불일치 같은 나쁜 인증서도 인자만 바꿔 만들 수 있다.
//  - 키: ECDSA P-256, 서명: ecdsa-with-SHA256. 인증서 하나가 스스로를 서명하고, 시험은 이 인증서 자체를 신뢰할 CA 로 넘긴다(`FetchUrlHooks.ca`).
//  - 이름은 `example.test`·`localhost` 같은 시험용 이름뿐이다. 개인정보를 넣지 않는다. 키는 시험 프로세스 메모리에만 있고 디스크에 쓰지 않는다.
//  - 유효 기간은 고정 날짜다(현재 시각을 읽지 않는다): 정상은 2020-01-01 ~ 2049-12-31, 만료는 2020-01-01 ~ 2021-01-01. 2049 이후는 UTCTime 으로 표현할 수 없어 쓰지 않는다.
import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';

const enc = new TextEncoder();

function lengthBytes(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return [0x80 | bytes.length, ...bytes];
}

function tlv(tag: number, ...parts: (Uint8Array | number[])[]): Uint8Array {
  const body = parts.flatMap((part) => [...part]);
  return Uint8Array.from([tag, ...lengthBytes(body.length), ...body]);
}

const sequence = (...parts: (Uint8Array | number[])[]): Uint8Array => tlv(0x30, ...parts);
const set = (...parts: (Uint8Array | number[])[]): Uint8Array => tlv(0x31, ...parts);
const utf8 = (text: string): Uint8Array => tlv(0x0c, enc.encode(text));
const utcTime = (text: string): Uint8Array => tlv(0x17, enc.encode(text));
const octetString = (...parts: (Uint8Array | number[])[]): Uint8Array => tlv(0x04, ...parts);
const bitString = (bytes: Uint8Array): Uint8Array => tlv(0x03, [0], bytes);
const boolTrue = (): Uint8Array => tlv(0x01, [0xff]);

function oid(dotted: string): Uint8Array {
  const arcs = dotted.split('.').map(Number);
  const bytes: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [arc & 0x7f];
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) chunk.unshift((rest & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, bytes);
}

const ECDSA_SHA256 = (): Uint8Array => sequence(oid('1.2.840.10045.4.3.2'));
const nameOf = (commonName: string): Uint8Array => sequence(set(sequence(oid('2.5.4.3'), utf8(commonName))));

export interface TestCertificateOptions {
  /** subjectAltName 의 DNS 이름들 (예: `['secure.example.test']`). 시험이 접속하는 이름과 맞아야 검증을 통과한다 */
  dnsNames: readonly string[];
  /** UTCTime `YYMMDDHHMMSSZ`. 기본 정상 인증서 */
  notBefore?: string;
  notAfter?: string;
  commonName?: string;
}

export interface TestCertificate {
  /** 인증서 PEM (서버의 `cert`, 클라이언트의 `ca` 로 쓴다) */
  certPem: string;
  /** 개인 키 PEM (서버의 `key`). 메모리에만 있다 */
  keyPem: string;
}

export const VALID_FROM = '200101000000Z';
export const VALID_UNTIL = '491231235959Z';
export const EXPIRED_UNTIL = '210101000000Z';

export function makeTestCertificate(options: TestCertificateOptions): TestCertificate {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const subject = nameOf(options.commonName ?? options.dnsNames[0] ?? 'localhost');
  const san = sequence(...options.dnsNames.map((name) => tlv(0x82, enc.encode(name)))); // dNSName [2]
  const extensions = tlv(0xa3, sequence(
    sequence(oid('2.5.29.19'), boolTrue(), octetString(sequence(boolTrue()))), // basicConstraints CA:TRUE (critical)
    sequence(oid('2.5.29.17'), octetString(san)),
  ));
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, [2])), // version v3
    tlv(0x02, [0x01, 0x23, 0x45, 0x67]), // 시리얼(양수)
    ECDSA_SHA256(),
    subject, // issuer = subject (자체서명)
    sequence(utcTime(options.notBefore ?? VALID_FROM), utcTime(options.notAfter ?? VALID_UNTIL)),
    subject,
    spki,
    extensions,
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = sequence(tbs, ECDSA_SHA256(), bitString(signature));
  const certPem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n').trimEnd()}\n-----END CERTIFICATE-----\n`;
  new X509Certificate(certPem); // 형식이 틀렸으면 여기서 던진다
  return { certPem, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}
