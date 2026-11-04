// 간단한 인라인 SVG 그래프 (외부 라이브러리·스크립트 없음). 숫자는 유한한 값만 쓰고, 글자는 모두 `h` 를 거쳐 가리고 이스케이프한다.
import { h, raw, text, type Raw } from './html.ts';

export interface Bar {
  label: string;
  value: number | null;
  tone?: 'b1' | 'b2';
  /** 값 옆에 붙일 글 (예: "3 / 5") */
  note?: string | undefined;
}

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const round = (value: number): number => Math.round(value * 100) / 100;

/** 가로 막대. `max` 는 100% 폭의 값, `ref` 는 기준선(예: 최소 통과율) */
export function barChart(title: string, bars: readonly Bar[], options: { max: number; ref?: { value: number; label: string } }): Raw {
  const left = 150;
  const width = 560;
  const barArea = width - left - 90;
  const rowH = 30;
  const height = bars.length * rowH + 28;
  const max = options.max > 0 && Number.isFinite(options.max) ? options.max : 1;
  const x = (value: number): number => left + Math.min(Math.max(value / max, 0), 1) * barArea;
  const rows = bars.map((bar, i) => {
    const y = 8 + i * rowH;
    const value = finite(bar.value);
    const shown = value === null ? '자료 없음' : (bar.note ?? String(round(value)));
    return `<text x="${left - 8}" y="${y + 15}" text-anchor="end">${text(bar.label, 30)}</text>`
      + (value === null ? '' : `<rect class="${bar.tone ?? 'b1'}" x="${left}" y="${y + 2}" width="${round(x(value) - left)}" height="18" rx="3"/>`)
      + `<text x="${(value === null ? left : x(value)) + 6}" y="${y + 15}">${text(shown, 24)}</text>`;
  }).join('');
  const ref = options.ref === undefined || finite(options.ref.value) === null ? '' :
    `<line class="ref" x1="${round(x(options.ref.value))}" x2="${round(x(options.ref.value))}" y1="2" y2="${height - 22}"/><text x="${round(x(options.ref.value))}" y="${height - 6}" text-anchor="middle">${text(options.ref.label, 30)}</text>`;
  return h`<figure><figcaption class="mute">${title}</figcaption><svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" role="img" aria-label="${title}"><line class="axis" x1="${left}" x2="${left}" y1="2" y2="${height - 22}"/>${raw(rows)}${raw(ref)}</svg></figure>`;
}

export interface LinePoint {
  label: string;
  value: number | null;
}

/** 꺾은선: 시간 순 값 (0~max). 값 없는 점은 건너뛴다 */
export function lineChart(title: string, points: readonly LinePoint[], options: { max: number; ref?: { value: number; label: string } }): Raw {
  const width = 560;
  const height = 180;
  const padL = 40;
  const padR = 16;
  const padT = 12;
  const padB = 34;
  const max = options.max > 0 && Number.isFinite(options.max) ? options.max : 1;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const px = (i: number): number => padL + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const py = (value: number): number => padT + innerH - Math.min(Math.max(value / max, 0), 1) * innerH;
  const usable = points.map((p, i) => ({ i, p, v: finite(p.value) })).filter((entry): entry is { i: number; p: LinePoint; v: number } => entry.v !== null);
  const path = usable.map((e, k) => `${k === 0 ? 'M' : 'L'}${round(px(e.i))},${round(py(e.v))}`).join(' ');
  const dots = usable.map((e) => `<circle cx="${round(px(e.i))}" cy="${round(py(e.v))}" r="3.5" class="b1"/><text x="${round(px(e.i))}" y="${round(py(e.v)) - 8}" text-anchor="middle">${round(e.v)}</text>`).join('');
  const labels = points.map((p, i) => `<text x="${round(px(i))}" y="${height - 10}" text-anchor="middle">${text(p.label, 12)}</text>`).join('');
  const ref = options.ref === undefined || finite(options.ref.value) === null ? '' :
    `<line class="ref" x1="${padL}" x2="${width - padR}" y1="${round(py(options.ref.value))}" y2="${round(py(options.ref.value))}"/><text x="${width - padR}" y="${round(py(options.ref.value)) - 4}" text-anchor="end">${text(options.ref.label, 30)}</text>`;
  return h`<figure><figcaption class="mute">${title}</figcaption><svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" role="img" aria-label="${title}"><line class="axis" x1="${padL}" x2="${padL}" y1="${padT}" y2="${padT + innerH}"/><line class="axis" x1="${padL}" x2="${width - padR}" y1="${padT + innerH}" y2="${padT + innerH}"/><text x="${padL - 6}" y="${padT + 4}" text-anchor="end">${round(max)}</text><text x="${padL - 6}" y="${padT + innerH + 4}" text-anchor="end">0</text>${raw(ref)}<path class="line" d="${path}"/>${raw(dots)}${raw(labels)}</svg></figure>`;
}
