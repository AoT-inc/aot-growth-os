// 인바운드 통화의 명시적 라우팅 규칙 (ADR-0014 §9). 첫 일치가 이기고, 일치하는 규칙이 없으면 거절한다(기본 거부).
// 라우팅은 "누가 받는가"만 정한다 — 권한을 바꾸지 않는다(trust-boundaries §2-7). 에이전트가 받더라도 도구·예산은 업무 명세와 정책이 정한다.
// 규칙은 인스턴스 설정(`instance/`)에 있고 에이전트 쓰기 경로 밖이다. AI 라우터는 만들지 않는다.
import { IssueCollector, isPlainObject, type ValidationResult } from '../validation.ts';

import { checkBusinessHours, withinBusinessHours, type BusinessHours } from './hours.ts';
import { isE164 } from './model.ts';
import { NAME_PATTERN } from '../conversation/outcome.ts';

export type RouteTarget =
  | { kind: 'agent'; orgUnit: string; role: string; objective: string }
  | { kind: 'human'; number: string }
  | { kind: 'reject'; reason: string };

export interface InboundRoute {
  id: string;
  /** 수신 번호(우리 번호) 목록. 생략하면 모든 번호 */
  to?: string[] | undefined;
  /** 발신 번호 목록. 끝이 `*` 이면 접두어 일치(예: +8210*). 생략하면 모든 발신자 */
  from?: string[] | undefined;
  /** 이 창 안에서만 일치 */
  hours?: BusinessHours | undefined;
  target: RouteTarget;
}

export interface RouteDecision {
  /** 일치한 규칙 id. 없으면 null (기본 거부) */
  routeId: string | null;
  target: RouteTarget;
}

export const DEFAULT_REJECT: RouteTarget = { kind: 'reject', reason: 'no_route' };

const ROUTE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function numberMatches(patterns: readonly string[], number: string | null): boolean {
  if (number === null) return false;
  return patterns.some((pattern) => (pattern.endsWith('*') ? number.startsWith(pattern.slice(0, -1)) : number === pattern));
}

export function routeInboundCall(routes: readonly InboundRoute[], call: { to: string; from: string | null }, at: Date): RouteDecision {
  for (const route of routes) {
    if (route.to !== undefined && !numberMatches(route.to, call.to)) continue;
    if (route.from !== undefined && !numberMatches(route.from, call.from)) continue;
    if (route.hours !== undefined && !withinBusinessHours(route.hours, at)) continue;
    return { routeId: route.id, target: route.target };
  }
  return { routeId: null, target: DEFAULT_REJECT };
}

/** 설정(JSON)에서 읽은 규칙 목록 검증. 모르는 키·잘못된 번호·중복 id 는 거부한다 */
export function validateInboundRoutes(input: unknown): ValidationResult<InboundRoute[]> {
  const out = new IssueCollector();
  if (!Array.isArray(input)) {
    out.add('', 'type', 'routes must be an array');
    return out.result([]);
  }
  const seen = new Set<string>();
  const routes: InboundRoute[] = [];
  input.forEach((item: unknown, index) => {
    const path = `routes[${index}]`;
    if (!isPlainObject(item)) return void out.add(path, 'type', 'a route must be an object');
    for (const key of Object.keys(item)) {
      if (!['id', 'to', 'from', 'hours', 'target'].includes(key)) out.add(`${path}.${key}`, 'unknown_key', `unknown key '${key}'`);
    }
    const id = item['id'];
    if (typeof id !== 'string' || !ROUTE_ID.test(id)) out.add(`${path}.id`, 'format', 'id must match [a-z0-9][a-z0-9-]*');
    else if (seen.has(id)) out.add(`${path}.id`, 'duplicate', `duplicate route id '${id}'`);
    else seen.add(id);
    const route: InboundRoute = { id: typeof id === 'string' ? id : '', target: DEFAULT_REJECT };
    for (const key of ['to', 'from'] as const) {
      const list = item[key];
      if (list === undefined) continue;
      const ok = Array.isArray(list) && list.length > 0 && list.every((n) => typeof n === 'string' && (isE164(n) || (key === 'from' && /^\+[0-9]{1,14}\*$/.test(n))));
      if (!ok) out.add(`${path}.${key}`, 'format', `${key} must be a non-empty list of E.164 numbers${key === 'from' ? ' (a trailing * matches a prefix)' : ''}`);
      else route[key] = [...(list as string[])];
    }
    if (item['hours'] !== undefined) {
      const hours = checkBusinessHours(item['hours'], `${path}.hours`, out);
      if (hours) route.hours = hours;
    }
    const target = item['target'];
    if (!isPlainObject(target)) out.add(`${path}.target`, 'required', 'target is required');
    else if (target['kind'] === 'agent') {
      for (const key of Object.keys(target)) if (!['kind', 'orgUnit', 'role', 'objective'].includes(key)) out.add(`${path}.target.${key}`, 'unknown_key', `unknown key '${key}'`);
      const { orgUnit, role, objective } = target;
      if (typeof orgUnit !== 'string' || orgUnit === '') out.add(`${path}.target.orgUnit`, 'required', 'orgUnit (slug) is required');
      if (typeof role !== 'string' || role === '') out.add(`${path}.target.role`, 'required', 'role (slug) is required');
      if (typeof objective !== 'string' || !NAME_PATTERN.test(objective)) out.add(`${path}.target.objective`, 'format', 'objective must be an intent key');
      if (typeof orgUnit === 'string' && typeof role === 'string' && typeof objective === 'string') route.target = { kind: 'agent', orgUnit, role, objective };
    } else if (target['kind'] === 'human') {
      if (!isE164(target['number'])) out.add(`${path}.target.number`, 'format', 'number must be an E.164 number');
      else route.target = { kind: 'human', number: target['number'] };
    } else if (target['kind'] === 'reject') {
      route.target = { kind: 'reject', reason: typeof target['reason'] === 'string' && target['reason'] !== '' ? target['reason'] : 'rejected_by_route' };
    } else out.add(`${path}.target.kind`, 'enum', 'target.kind must be agent|human|reject');
    routes.push(route);
  });
  return out.result(routes);
}
