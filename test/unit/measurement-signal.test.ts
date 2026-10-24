// 측정 신호 정의 형식 (D2, A6-U10). 값이 아니라 형식만 본다. 표 시험.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { validateMeasurementSignal, type Issue } from '@aot/domain';

import { REPO_ROOT } from '../support/schema-snapshot.ts';

const valid = (): Record<string, unknown> => ({
  id: 'weekly-landing-conversions',
  description: '랜딩 페이지 1개의 주간 목표 행동 전환 수',
  page_ref: 'landing:example-product',
  action: 'signup',
  period: 'iso_week',
  tz: 'Asia/Seoul',
  min_observations: 1,
  attachment_required: true,
});
const errorsOf = (input: unknown): Issue[] => {
  const result = validateMeasurementSignal(input);
  assert.equal(result.ok, false, JSON.stringify(input));
  return result.ok ? [] : result.errors;
};
const has = (errors: Issue[], path: string, code: string): boolean => errors.some((e) => e.path === path && e.code === code);

describe('validateMeasurementSignal', () => {
  it('accepts a complete definition, with or without pass_threshold', () => {
    assert.equal(validateMeasurementSignal(valid()).ok, true);
    for (const pass_threshold of [0, 0.05, 12, -1.5]) assert.equal(validateMeasurementSignal({ ...valid(), pass_threshold }).ok, true, String(pass_threshold));
  });

  it('accepts UTC and region/city zones, and larger observation counts', () => {
    for (const tz of ['UTC', 'America/New_York', 'America/Argentina/Buenos_Aires']) assert.equal(validateMeasurementSignal({ ...valid(), tz }).ok, true, tz);
    assert.equal(validateMeasurementSignal({ ...valid(), min_observations: 30 }).ok, true);
  });

  it('rejects unknown keys (a definition cannot carry anything the format does not know)', () => {
    assert.ok(has(errorsOf({ ...valid(), unit: 'count' }), 'unit', 'unknown_field'));
    assert.ok(has(errorsOf({ ...valid(), url: 'x' }), 'url', 'unknown_field'));
    assert.ok(has(errorsOf({ ...valid(), _comment: 'memo' }), '_comment', 'unknown_field'));
  });

  it('rejects non-objects', () => {
    for (const input of [null, [], 'text', 3, undefined]) assert.ok(has(errorsOf(input), '', 'type'));
  });

  const table: { name: string; mutate: (s: Record<string, unknown>) => void; path: string; code: string }[] = [
    { name: 'period other than iso_week', mutate: (s) => { s['period'] = 'calendar_month'; }, path: 'period', code: 'enum' },
    { name: 'period missing', mutate: (s) => { delete s['period']; }, path: 'period', code: 'enum' },
    { name: 'tz not an IANA zone', mutate: (s) => { s['tz'] = 'Mars/Olympus'; }, path: 'tz', code: 'format' },
    { name: 'tz as an offset', mutate: (s) => { s['tz'] = '+09:00'; }, path: 'tz', code: 'format' },
    { name: 'tz blank', mutate: (s) => { s['tz'] = ' '; }, path: 'tz', code: 'required' },
    { name: 'tz missing', mutate: (s) => { delete s['tz']; }, path: 'tz', code: 'required' },
    { name: 'min_observations 0', mutate: (s) => { s['min_observations'] = 0; }, path: 'min_observations', code: 'range' },
    { name: 'min_observations negative', mutate: (s) => { s['min_observations'] = -3; }, path: 'min_observations', code: 'range' },
    { name: 'min_observations fractional', mutate: (s) => { s['min_observations'] = 1.5; }, path: 'min_observations', code: 'range' },
    { name: 'min_observations as text', mutate: (s) => { s['min_observations'] = '2'; }, path: 'min_observations', code: 'range' },
    { name: 'min_observations missing', mutate: (s) => { delete s['min_observations']; }, path: 'min_observations', code: 'range' },
    { name: 'attachment_required false', mutate: (s) => { s['attachment_required'] = false; }, path: 'attachment_required', code: 'must_be_true' },
    { name: 'attachment_required missing', mutate: (s) => { delete s['attachment_required']; }, path: 'attachment_required', code: 'must_be_true' },
    { name: 'attachment_required as text', mutate: (s) => { s['attachment_required'] = 'true'; }, path: 'attachment_required', code: 'must_be_true' },
    { name: 'pass_threshold as text', mutate: (s) => { s['pass_threshold'] = '5%'; }, path: 'pass_threshold', code: 'type' },
    { name: 'pass_threshold NaN', mutate: (s) => { s['pass_threshold'] = Number.NaN; }, path: 'pass_threshold', code: 'type' },
    { name: 'pass_threshold Infinity', mutate: (s) => { s['pass_threshold'] = Number.POSITIVE_INFINITY; }, path: 'pass_threshold', code: 'type' },
    { name: 'pass_threshold null', mutate: (s) => { s['pass_threshold'] = null; }, path: 'pass_threshold', code: 'type' },
    { name: 'id with spaces or capitals', mutate: (s) => { s['id'] = 'Weekly Conversions'; }, path: 'id', code: 'format' },
    { name: 'id missing', mutate: (s) => { delete s['id']; }, path: 'id', code: 'required' },
    { name: 'description missing', mutate: (s) => { delete s['description']; }, path: 'description', code: 'required' },
    { name: 'description too long', mutate: (s) => { s['description'] = 'x'.repeat(501); }, path: 'description', code: 'too_long' },
    { name: 'page_ref is an address', mutate: (s) => { s['page_ref'] = 'https://shop.example.com/landing'; }, path: 'page_ref', code: 'url_not_allowed' },
    { name: 'page_ref with a host name but no scheme', mutate: (s) => { s['page_ref'] = 'shop.example.com/landing'; }, path: 'page_ref', code: 'format' },
    { name: 'page_ref without a kind prefix', mutate: (s) => { s['page_ref'] = 'example-product'; }, path: 'page_ref', code: 'format' },
    { name: 'page_ref with capitals', mutate: (s) => { s['page_ref'] = 'Landing:Example'; }, path: 'page_ref', code: 'format' },
    { name: 'action with spaces', mutate: (s) => { s['action'] = 'sign up'; }, path: 'action', code: 'format' },
    { name: 'action missing', mutate: (s) => { delete s['action']; }, path: 'action', code: 'required' },
    { name: 'a URL inside the description', mutate: (s) => { s['description'] = '전환 수 (https://shop.example.com/landing 기준)'; }, path: 'description', code: 'url_not_allowed' },
    { name: 'a www address inside the description', mutate: (s) => { s['description'] = 'www.shop.example.com 의 전환 수'; }, path: 'description', code: 'url_not_allowed' },
  ];
  for (const { name, mutate, path, code } of table) {
    it(`rejects: ${name}`, () => {
      const signal = valid();
      mutate(signal);
      assert.ok(has(errorsOf(signal), path, code), `expected ${path}/${code}`);
    });
  }

  it('reports every problem at once (messages name the field)', () => {
    const errors = errorsOf({ ...valid(), period: 'day', tz: 'Nowhere/Land', min_observations: 0, attachment_required: false });
    assert.deepEqual(errors.map((e) => e.path).sort(), ['attachment_required', 'min_observations', 'period', 'tz']);
    assert.ok(errors.every((e) => e.message.length > 0));
  });

  it('every signal file under packs/ is valid and holds no address', () => {
    const packs = join(REPO_ROOT, 'packs');
    for (const pack of readdirSync(packs, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const dir = join(packs, pack.name, 'measurement-signals');
      let files: string[] = [];
      try { files = readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { /* the pack has none */ }
      for (const file of files) {
        const text = readFileSync(join(dir, file), 'utf8');
        const result = validateMeasurementSignal(JSON.parse(text));
        assert.equal(result.ok, true, `${pack.name}/${file}: ${result.ok ? '' : JSON.stringify(result.errors)}`);
        assert.doesNotMatch(text, /https?:\/\//);
      }
    }
  });
});
