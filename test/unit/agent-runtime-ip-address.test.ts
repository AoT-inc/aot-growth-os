// A5 U5: 공인 주소 판정 표 (SSRF 방지). 거부 대역의 경계(첫 주소·마지막 주소·바로 바깥 주소)와 IPv6·IPv4 매핑·변환 형식을 전수로 본다.
// 판정 규칙은 packages/agent-runtime/src/ip-address.ts 머리말에 있다. 이 표는 규칙을 시험 쪽에서 다시 적은 것이라 구현과 따로 바뀌면 깨진다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addressFamily, isPublicAddress, parseIPv4, parseIPv6 } from '@aot/agent-runtime';

type Row = readonly [address: string, allowed: boolean, why: string];

const rows: readonly Row[] = [
  // ---- IPv4 거부: 대역의 첫/마지막 ----
  ['0.0.0.0', false, 'unspecified'], ['0.255.255.255', false, '0/8 end'], ['1.0.0.0', true, 'just outside 0/8'],
  ['9.255.255.255', true, 'just below 10/8'], ['10.0.0.0', false, '10/8 start'], ['10.255.255.255', false, '10/8 end'], ['11.0.0.0', true, 'just above 10/8'],
  ['100.63.255.255', true, 'just below CGNAT'], ['100.64.0.0', false, 'CGNAT start'], ['100.127.255.255', false, 'CGNAT end'], ['100.128.0.0', true, 'just above CGNAT'],
  ['126.255.255.255', true, 'below loopback'], ['127.0.0.0', false, 'loopback start'], ['127.0.0.1', false, 'loopback'], ['127.255.255.255', false, 'loopback end'], ['128.0.0.0', true, 'above loopback'],
  ['169.253.255.255', true, 'below link-local'], ['169.254.0.0', false, 'link-local start'], ['169.254.169.254', false, 'cloud metadata'], ['169.254.255.255', false, 'link-local end'], ['169.255.0.0', true, 'above link-local'],
  ['172.15.255.255', true, 'just below 172.16/12'], ['172.16.0.0', false, '172.16/12 start'], ['172.31.255.255', false, '172.16/12 end'], ['172.32.0.0', true, 'just above 172.16/12'],
  ['191.255.255.255', true, 'below 192.0.0/24'], ['192.0.0.0', false, 'IETF protocol 192.0.0/24'], ['192.0.0.255', false, 'IETF protocol end'], ['192.0.1.0', true, 'between 192.0.0/24 and 192.0.2/24'],
  ['192.0.2.1', false, 'TEST-NET-1'], ['192.0.3.0', true, 'above TEST-NET-1'],
  ['192.88.98.255', true, 'below 6to4 relay'], ['192.88.99.1', false, '6to4 relay anycast'], ['192.88.100.0', true, 'above 6to4 relay'],
  ['192.167.255.255', true, 'just below 192.168/16'], ['192.168.0.0', false, '192.168/16 start'], ['192.168.255.255', false, '192.168/16 end'], ['192.169.0.0', true, 'just above 192.168/16'],
  ['198.17.255.255', true, 'below benchmarking'], ['198.18.0.0', false, 'benchmarking start'], ['198.19.255.255', false, 'benchmarking end'], ['198.20.0.0', true, 'above benchmarking'],
  ['198.51.99.255', true, 'below TEST-NET-2'], ['198.51.100.7', false, 'TEST-NET-2'], ['198.51.101.0', true, 'above TEST-NET-2'],
  ['203.0.112.255', true, 'below TEST-NET-3'], ['203.0.113.7', false, 'TEST-NET-3'], ['203.0.114.0', true, 'above TEST-NET-3'],
  ['223.255.255.255', true, 'below multicast'], ['224.0.0.1', false, 'multicast'], ['239.255.255.255', false, 'multicast end'], ['240.0.0.0', false, 'reserved'], ['255.255.255.255', false, 'broadcast'],
  // ---- IPv4 허용(공인) 몇 개 ----
  ['1.1.1.1', true, 'public'], ['8.8.8.8', true, 'public'], ['93.184.216.34', true, 'public'], ['203.0.114.1', true, 'public'], ['223.1.1.1', true, 'public'],
  // ---- IPv4 표기 오류는 거부(기본 거부) ----
  ['', false, 'empty'], ['1.2.3', false, 'three octets'], ['1.2.3.4.5', false, 'five octets'], ['256.1.1.1', false, 'octet > 255'], ['01.2.3.4', false, 'leading zero (octal ambiguity)'],
  ['1.2.3.-4', false, 'negative'], ['a.b.c.d', false, 'letters'], ['127.1', false, 'short form'], ['2130706433', false, 'decimal integer form'], ['0x7f.0.0.1', false, 'hex octet'],
  ['localhost', false, 'name'], ['example.com', false, 'name'], [' 8.8.8.8', false, 'leading space'], ['8.8.8.8 ', false, 'trailing space'],
  // ---- IPv6 거부 ----
  ['::', false, 'unspecified'], ['::1', false, 'loopback'], ['0:0:0:0:0:0:0:1', false, 'loopback expanded'],
  ['fc00::1', false, 'ULA start'], ['fd12:3456:789a::1', false, 'ULA'], ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false, 'ULA end'],
  ['fe80::1', false, 'link-local'], ['febf::1', false, 'link-local end'], ['fec0::1', false, 'deprecated site-local'], ['fe00::1', false, 'outside 2000::/3'],
  ['ff02::1', false, 'multicast'], ['ff00::', false, 'multicast start'], ['1000::1', false, 'outside 2000::/3'], ['4000::1', false, 'outside 2000::/3'], ['0100::1', false, 'discard 100::/64'],
  ['2001::1', false, 'Teredo 2001::/32'], ['2001:0:4136:e378:8000:63bf:3fff:fdd2', false, 'Teredo'], ['2001:1ff:ffff::1', false, '2001::/23 end'], ['2001:200::1', true, 'just above 2001::/23'],
  ['2001:db8::1', false, 'documentation'], ['2001:db8:ffff::1', false, 'documentation'], ['3fff::1', false, 'documentation 3fff::/20'], ['3fff:fff::1', false, 'documentation end'], ['3fff:1000::1', true, 'just above 3fff::/20'],
  ['::127.0.0.1', false, 'IPv4-compatible (deprecated)'], ['::8.8.8.8', false, 'IPv4-compatible (deprecated)'], ['::7f00:1', false, 'IPv4-compatible hex'],
  ['fe80::1%eth0', false, 'zone id'], ['::1%lo', false, 'zone id'],
  // ---- IPv4 매핑 ::ffff:0:0/96 : 품은 IPv4 로 판정 ----
  ['::ffff:127.0.0.1', false, 'mapped loopback'], ['::ffff:7f00:1', false, 'mapped loopback hex'], ['::FFFF:7F00:1', false, 'mapped loopback upper case'],
  ['0:0:0:0:0:ffff:7f00:1', false, 'mapped loopback expanded'], ['::ffff:10.0.0.1', false, 'mapped 10/8'], ['::ffff:a00:1', false, 'mapped 10/8 hex'],
  ['::ffff:192.168.1.1', false, 'mapped 192.168/16'], ['::ffff:169.254.169.254', false, 'mapped metadata'], ['::ffff:a9fe:a9fe', false, 'mapped metadata hex'],
  ['::ffff:172.16.0.1', false, 'mapped 172.16/12'], ['::ffff:0.0.0.0', false, 'mapped unspecified'], ['::ffff:100.64.0.1', false, 'mapped CGNAT'],
  ['::ffff:8.8.8.8', true, 'mapped public'], ['::ffff:808:808', true, 'mapped public hex'], ['::ffff:93.184.216.34', true, 'mapped public'],
  // ---- NAT64 64:ff9b::/96 : 품은 IPv4 로 판정 ----
  ['64:ff9b::7f00:1', false, 'NAT64 loopback'], ['64:ff9b::127.0.0.1', false, 'NAT64 loopback dotted'], ['64:ff9b::a00:1', false, 'NAT64 10/8'], ['64:ff9b::a9fe:a9fe', false, 'NAT64 metadata'],
  ['64:ff9b::808:808', true, 'NAT64 public'], ['64:ff9b::8.8.8.8', true, 'NAT64 public dotted'],
  // ---- 6to4 2002::/16 : 품은 IPv4 로 판정 ----
  ['2002:7f00:1::', false, '6to4 loopback'], ['2002:7f00:1::1', false, '6to4 loopback'], ['2002:a00:1::', false, '6to4 10/8'], ['2002:c0a8:101::', false, '6to4 192.168/16'], ['2002:a9fe:a9fe::', false, '6to4 metadata'],
  ['2002:808:808::', true, '6to4 public'], ['2002:5db8:d822::1', true, '6to4 public'],
  // ---- IPv6 허용(전역 유니캐스트) ----
  ['2606:4700:4700::1111', true, 'public'], ['2001:4860:4860::8888', true, 'public'], ['2a00:1450:4001:81c::200e', true, 'public'], ['2000::1', true, 'start of 2000::/3'],
  ['3ffe::1', true, 'inside 2000::/3'], ['3fff:ffff::1', true, 'above 3fff::/20 inside 2000::/3'], ['2400:cb00::1', true, 'public'],
  // ---- IPv6 표기 오류는 거부 ----
  ['2001:db8::1::2', false, 'two ::'], ['1:2:3:4:5:6:7', false, 'seven groups'], ['1:2:3:4:5:6:7:8:9', false, 'nine groups'], ['12345::1', false, 'group too long'],
  ['g::1', false, 'non-hex'], [':::', false, 'three colons'], ['1:2:3:4:5:6:7::8', false, ':: with eight groups'], ['::ffff:300.1.1.1', false, 'bad dotted tail'], [':1', false, 'single colon'],
];

describe('isPublicAddress: decision table', () => {
  for (const [address, allowed, why] of rows) {
    it(`${allowed ? 'allows' : 'refuses'} ${JSON.stringify(address)} (${why})`, () => {
      assert.equal(isPublicAddress(address), allowed);
    });
  }
});

describe('isPublicAddress: every refused IPv4 range is refused end to end', () => {
  // 시험 쪽에서 다시 적은 거부 대역. 대역 안의 시작·끝·무작위에 가까운 중간 주소가 모두 거부되고, 바로 바깥 두 주소는 (다른 거부 대역에 걸리지 않는 한) 허용된다.
  const denied: readonly (readonly [string, number])[] = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ];
  const toInt = (text: string): number => text.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
  const toText = (value: number): string => [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
  const inDenied = (value: number): boolean => denied.some(([base, bits]) => value >= toInt(base) && value < toInt(base) + 2 ** (32 - bits));

  for (const [base, bits] of denied) {
    it(`${base}/${bits}`, () => {
      const first = toInt(base);
      const last = first + 2 ** (32 - bits) - 1;
      const middle = first + Math.floor((last - first) / 2);
      for (const value of [first, first + 1, middle, last - 1, last]) assert.equal(isPublicAddress(toText(value)), false, toText(value));
      for (const value of [first - 1, last + 1]) {
        if (value < 0 || value > 0xffffffff || inDenied(value)) continue;
        assert.equal(isPublicAddress(toText(value)), true, `${toText(value)} is outside every refused range`);
      }
    });
  }

  it('the first octet sweep: 1.x.x.x .. 223.x.x.x is public except the refused first octets', () => {
    const refusedFirstOctets = new Set([10, 127]); // 0/8 은 아래에서, 100.x·169.x·172.x·192.x·198.x·203.x 는 일부만 거부되므로 대표 주소로 본다
    for (let first = 1; first <= 223; first += 1) {
      if (refusedFirstOctets.has(first)) assert.equal(isPublicAddress(`${first}.1.2.3`), false, `${first}.1.2.3`);
      else if (![100, 169, 172, 192, 198, 203].includes(first)) assert.equal(isPublicAddress(`${first}.1.2.3`), true, `${first}.1.2.3`);
    }
    for (let first = 224; first <= 255; first += 1) assert.equal(isPublicAddress(`${first}.1.2.3`), false, `${first}.1.2.3`);
    assert.equal(isPublicAddress('0.1.2.3'), false);
  });
});

describe('IPv6 forms that embed IPv4 follow the embedded address', () => {
  it('mapped, NAT64 and 6to4 give the same answer as the embedded IPv4 for every refused /8 sample and a public sample', () => {
    const embedded: readonly [v4: string, hi: string, lo: string][] = [
      ['127.0.0.1', '7f00', '1'], ['10.1.2.3', 'a01', '203'], ['192.168.9.9', 'c0a8', '909'], ['169.254.169.254', 'a9fe', 'a9fe'], ['172.20.0.5', 'ac14', '5'],
      ['100.64.1.1', '6440', '101'], ['8.8.4.4', '808', '404'], ['93.184.216.34', '5db8', 'd822'], ['1.1.1.1', '101', '101'],
    ];
    for (const [v4, hi, lo] of embedded) {
      const expected = isPublicAddress(v4);
      assert.equal(isPublicAddress(`::ffff:${hi}:${lo}`), expected, `mapped ${v4}`);
      assert.equal(isPublicAddress(`::ffff:${v4}`), expected, `mapped dotted ${v4}`);
      assert.equal(isPublicAddress(`64:ff9b::${hi}:${lo}`), expected, `NAT64 ${v4}`);
      assert.equal(isPublicAddress(`2002:${hi}:${lo}::`), expected, `6to4 ${v4}`);
    }
  });
});

describe('parsers', () => {
  it('parseIPv4 accepts only canonical dotted decimals', () => {
    assert.deepEqual(parseIPv4('1.2.3.4'), [1, 2, 3, 4]);
    assert.deepEqual(parseIPv4('0.0.0.0'), [0, 0, 0, 0]);
    for (const bad of ['1.2.3', '1.2.3.04', '1.2.3.256', '1..2.3', '1.2.3.4 ', '+1.2.3.4', '1.2.3.4/8', '0x1.2.3.4']) assert.equal(parseIPv4(bad), null, bad);
  });

  it('parseIPv6 expands :: and dotted tails; refuses malformed text and zone ids', () => {
    assert.deepEqual(parseIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(parseIPv6('::'), [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(parseIPv6('1::'), [1, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(parseIPv6('2001:db8::8:800:200c:417a'), [0x2001, 0xdb8, 0, 0, 0x8, 0x800, 0x200c, 0x417a]);
    assert.deepEqual(parseIPv6('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    assert.deepEqual(parseIPv6('1:2:3:4:5:6:1.2.3.4'), [1, 2, 3, 4, 5, 6, 0x102, 0x304]);
    for (const bad of ['', '1.2.3.4', 'fe80::1%eth0', '1:2', ':::', '1::2::3', '::g', '::1.2.3', '1:2:3:4:5:6:7:8:9']) assert.equal(parseIPv6(bad), null, bad);
  });

  it('addressFamily tells the literal kind and 0 for names', () => {
    assert.equal(addressFamily('8.8.8.8'), 4);
    assert.equal(addressFamily('2606:4700::1111'), 6);
    assert.equal(addressFamily('example.com'), 0);
    assert.equal(addressFamily('999.1.1.1'), 0);
  });
});
