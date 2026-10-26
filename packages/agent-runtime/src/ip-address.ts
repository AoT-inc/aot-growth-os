// 공인 주소 판정 (SSRF 방지, 단계 A5 U5). `fetch_url` 이 DNS 로 해석한 주소(또는 URL 의 IP 리터럴)가 "인터넷의 공인 유니캐스트 주소"일 때만 연결을 허용한다.
// 기본 거부다: 파싱할 수 없거나 목록에 없는 모양은 모두 거부한다. 외부 의존성 없음(node:net 의 isIP 만 쓰지 않고 직접 파싱해 표기 차이를 만들지 않는다).
//  - IPv4: 0/8, 10/8, 100.64/10(CGNAT), 127/8, 169.254/16(링크로컬·클라우드 메타데이터), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16,
//    198.18/15, 198.51.100/24, 203.0.113/24, 224/4(멀티캐스트), 240/4(예약, 255.255.255.255 포함) 를 거부한다.
//  - IPv6: 2000::/3(전역 유니캐스트) 안의 주소만 허용하되 2001::/23(Teredo·ORCHID 등 IETF 예약), 2001:db8::/32, 3fff::/20(문서용)은 거부한다.
//    IPv4 를 품은 형식은 품은 IPv4 를 같은 규칙으로 판정한다: IPv4 매핑 ::ffff:0:0/96, NAT64 64:ff9b::/96, 6to4 2002::/16. IPv4 호환 ::a.b.c.d(폐기됨)는 거부한다.
//    ::1, ::, fc00::/7(ULA), fe80::/10(링크로컬), fec0::/10(폐기된 사이트로컬), ff00::/8(멀티캐스트)는 2000::/3 밖이라 거부된다. 존 ID(`%eth0`)가 붙은 주소는 거부한다.

/** [기준 주소, 접두 길이] */
const IPV4_DENIED: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

/** 점으로 구분된 10진 4개(0~255, 불필요한 앞자리 0 없음). 아니면 null */
export function parseIPv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

const ipv4ToInt = (octets: readonly number[]): number => ((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 + octets[3]!;

const DENIED_V4: readonly (readonly [number, number])[] = IPV4_DENIED.map(([base, bits]) => [ipv4ToInt(parseIPv4(base)!), bits] as const);

function inPrefixV4(value: number, base: number, bits: number): boolean {
  const size = 2 ** (32 - bits);
  return value >= base && value < base + size;
}

export function isPublicIPv4(octets: readonly number[]): boolean {
  const value = ipv4ToInt(octets);
  return !DENIED_V4.some(([base, bits]) => inPrefixV4(value, base, bits));
}

/** 8개의 16비트 조각. `::` 압축과 끝의 점 표기 IPv4(`::ffff:1.2.3.4`)를 풀어 준다. 존 ID 가 있거나 형식이 틀리면 null */
export function parseIPv6(text: string): number[] | null {
  if (text.includes('%') || !text.includes(':')) return null;
  let head = text;
  let tail: number[] = [];
  const dotted = text.lastIndexOf('.') >= 0;
  if (dotted) {
    const cut = text.lastIndexOf(':');
    const v4 = parseIPv4(text.slice(cut + 1));
    if (v4 === null) return null;
    tail = [v4[0]! * 256 + v4[1]!, v4[2]! * 256 + v4[3]!];
    head = text.slice(0, cut + 1);
    // `::1.2.3.4` 는 head 가 `::` 로 끝난다. `x:y:1.2.3.4` 는 head 가 `x:y:` 이므로 마지막 ':' 를 뗀다
    if (!head.endsWith('::')) head = head.slice(0, -1);
  }
  const doubleAt = head.indexOf('::');
  if (doubleAt !== head.lastIndexOf('::')) return null;
  const pieces = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  let groups: number[];
  if (doubleAt >= 0) {
    const left = pieces(head.slice(0, doubleAt));
    const right = pieces(head.slice(doubleAt + 2));
    if (left === null || right === null) return null;
    const fill = 8 - left.length - right.length - tail.length;
    if (fill < 1) return null; // `::` 는 0 조각 하나 이상을 대신한다
    groups = [...left, ...Array.from<number>({ length: fill }).fill(0), ...right, ...tail];
  } else {
    const all = pieces(head);
    if (all === null) return null;
    groups = [...all, ...tail];
  }
  return groups.length === 8 ? groups : null;
}

const v4Of = (hi: number, lo: number): number[] => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

export function isPublicIPv6(groups: readonly number[]): boolean {
  const g = groups;
  const head5Zero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  // IPv4 매핑 ::ffff:a.b.c.d
  if (head5Zero && g[5] === 0xffff) return isPublicIPv4(v4Of(g[6]!, g[7]!));
  // NAT64 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return isPublicIPv4(v4Of(g[6]!, g[7]!));
  // 2000::/3 밖(::, ::1, IPv4 호환, ULA, 링크로컬, 사이트로컬, 멀티캐스트 등)은 모두 거부
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  // 6to4 2002::/16: 품은 IPv4 를 판정
  if (g[0] === 0x2002) return isPublicIPv4(v4Of(g[1]!, g[2]!));
  // 2001::/23 (Teredo 2001::/32, ORCHID, 벤치마크 등 IETF 예약), 2001:db8::/32 문서용
  if (g[0] === 0x2001 && (g[1]! < 0x200 || g[1] === 0x0db8)) return false;
  // 3fff::/20 문서용
  if (g[0] === 0x3fff && g[1]! < 0x1000) return false;
  return true;
}

/** 문자열 IP 가 공인 주소인가. 파싱할 수 없으면 false (기본 거부) */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4 !== null) return isPublicIPv4(v4);
  const v6 = parseIPv6(address);
  return v6 !== null && isPublicIPv6(v6);
}

/** 주소 문자열의 족. IP 가 아니면 0 */
export function addressFamily(address: string): 4 | 6 | 0 {
  if (parseIPv4(address) !== null) return 4;
  if (parseIPv6(address) !== null) return 6;
  return 0;
}
