// 측정 값 시험 공용 (A6-U13): 예제 팩의 측정 신호 정의.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MeasurementSignal } from '@aot/domain';

import { REPO_ROOT } from './schema-snapshot.ts';

export const PACK_SIGNAL_PATH = join(REPO_ROOT, 'packs/example-marketing/measurement-signals/weekly-landing-conversions.json');
export const PACK_SIGNAL = JSON.parse(readFileSync(PACK_SIGNAL_PATH, 'utf8')) as MeasurementSignal;
/** 2026-W43(Asia/Seoul)이 끝난 뒤의 월요일 10:00 Asia/Seoul */
export const AFTER_W43 = '2026-10-26T01:00:00.000Z';
export const W43_KEY = 'measurement:weekly-landing-conversions@2026-W43';
