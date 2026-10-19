// 정책 파일용 YAML 부분집합 파서 (ADR-0013 Amendment). 의존성을 더하지 않으려고 직접 구현한다.
// 정책은 사람이 검토하는 작은 파일이므로, 검토를 어렵게 하는 YAML 기능은 받지 않고 오류로 돌려준다.
//
// 받는 것: 블록 매핑(`key: value`), 블록 시퀀스(`- item`, `- key: value` 로 시작하는 매핑 항목),
//          한 줄 흐름 시퀀스(`[a, "b"]`, 스칼라만)·흐름 매핑(`{a: 1, b: [x, y]}`, 값은 스칼라 또는 스칼라 흐름 시퀀스), 주석(`#`),
//          스칼라: 따옴표 없는 문자열, '작은따옴표', "큰따옴표"(\" \\ \n \t), 정수·소수, true/false, null/~
// 거부하는 것: 탭 들여쓰기, 앵커(&)·별칭(*)·태그(!), 블록 스칼라(| >), 여러 문서(---), 지시어(%),
//             중복 키, 중첩 흐름, 따옴표 없는 값 안의 `: `·` #`
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export class YamlError extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.name = 'YamlError';
    this.line = line;
  }
}

interface Line {
  no: number;
  indent: number;
  text: string;
}

export function parseYaml(source: string): YamlValue {
  const lines = toLines(source);
  if (lines.length === 0) throw new YamlError(1, 'empty document');
  const parser = new Parser(lines);
  const value = parser.block(lines[0]!.indent);
  if (parser.pos < lines.length) throw new YamlError(lines[parser.pos]!.no, 'unexpected indentation');
  return value;
}

function toLines(source: string): Line[] {
  const out: Line[] = [];
  source.replace(/\r\n?/g, '\n').split('\n').forEach((raw, index) => {
    const no = index + 1;
    const leading = /^[ \t]*/.exec(raw)![0];
    if (leading.includes('\t')) throw new YamlError(no, 'tabs are not allowed for indentation');
    const text = stripComment(raw.slice(leading.length), no).trimEnd();
    if (text === '') return;
    if (text === '---' || text === '...' || text.startsWith('%')) throw new YamlError(no, 'directives and multiple documents are not supported');
    out.push({ no, indent: leading.length, text });
  });
  return out;
}

/** 따옴표 밖의 `#`(줄 처음 또는 공백 뒤)부터 끝까지 지운다. */
function stripComment(text: string, no: number): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote === '"') {
      if (ch === '\\') i += 1;
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") i += 1;
        else quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || text[i - 1] === ' ')) {
      return text.slice(0, i);
    }
  }
  if (quote !== null) throw new YamlError(no, 'unterminated quoted string');
  return text;
}

const KEY = /^([A-Za-z_][A-Za-z0-9_.-]*)[ ]*:(?: +(.*))?$/;
const isSequenceItem = (text: string) => text === '-' || text.startsWith('- ');

class Parser {
  pos = 0;
  readonly lines: Line[];
  constructor(lines: Line[]) {
    this.lines = lines;
  }

  block(indent: number): YamlValue {
    const line = this.lines[this.pos]!;
    if (line.indent !== indent) throw new YamlError(line.no, 'unexpected indentation');
    return isSequenceItem(line.text) ? this.sequence(indent) : this.mapping(indent);
  }

  mapping(indent: number): { [key: string]: YamlValue } {
    const out: { [key: string]: YamlValue } = {};
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos]!;
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlError(line.no, 'unexpected indentation');
      if (isSequenceItem(line.text)) throw new YamlError(line.no, 'a sequence item cannot appear inside a mapping here');
      const match = KEY.exec(line.text);
      if (!match) throw new YamlError(line.no, 'expected `key: value` (keys are plain identifiers)');
      const key = match[1]!;
      if (Object.hasOwn(out, key)) throw new YamlError(line.no, `duplicate key '${key}'`);
      this.pos += 1;
      const rest = match[2];
      if (rest !== undefined && rest !== '') {
        out[key] = inlineValue(rest, line.no);
        continue;
      }
      const next = this.lines[this.pos];
      if (next && next.indent > indent) out[key] = this.block(next.indent);
      else if (next && next.indent === indent && isSequenceItem(next.text)) out[key] = this.sequence(indent);
      else out[key] = null;
    }
    return out;
  }

  sequence(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos]!;
      if (line.indent !== indent || !isSequenceItem(line.text)) {
        if (line.indent > indent) throw new YamlError(line.no, 'unexpected indentation');
        break;
      }
      const content = line.text === '-' ? '' : line.text.slice(2);
      const offset = line.text.length - content.trimStart().length;
      const item = content.trimStart();
      if (item === '') {
        this.pos += 1;
        const next = this.lines[this.pos];
        if (!next || next.indent <= indent) out.push(null);
        else out.push(this.block(next.indent));
      } else if (KEY.test(item)) {
        // `- key: value` 는 항목 내용 위치를 들여쓰기로 하는 매핑의 첫 줄이다.
        this.lines[this.pos] = { no: line.no, indent: indent + offset, text: item };
        out.push(this.mapping(indent + offset));
      } else if (isSequenceItem(item)) {
        throw new YamlError(line.no, 'nested inline sequences (`- - x`) are not supported');
      } else {
        this.pos += 1;
        out.push(inlineValue(item, line.no));
      }
    }
    return out;
  }
}

function inlineValue(text: string, no: number): YamlValue {
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new YamlError(no, 'a flow sequence must close on the same line');
    return splitFlow(text.slice(1, -1), no).map((part) => scalar(part, no));
  }
  if (text.startsWith('{')) {
    if (!text.endsWith('}')) throw new YamlError(no, 'a flow mapping must close on the same line');
    const out: { [key: string]: YamlValue } = {};
    for (const part of splitFlow(text.slice(1, -1), no, true)) {
      const match = KEY.exec(part);
      if (!match || match[2] === undefined) throw new YamlError(no, 'flow mapping entries must be `key: value`');
      if (Object.hasOwn(out, match[1]!)) throw new YamlError(no, `duplicate key '${match[1]!}'`);
      const value = match[2];
      out[match[1]!] = value.startsWith('[') ? inlineValue(value, no) : scalar(value, no);
    }
    return out;
  }
  return scalar(text, no);
}

/** 쉼표로 나눈다. `allowSequences` 면 한 단계의 `[...]`(흐름 매핑의 값)를 한 항목으로 둔다. */
function splitFlow(inner: string, no: number, allowSequences = false): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (quote) {
      current += ch;
      if (quote === '"' && ch === '\\') {
        current += inner[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '[' && allowSequences && depth === 0) {
      depth = 1;
      current += ch;
    } else if (ch === ']' && depth === 1) {
      depth = 0;
      current += ch;
    } else if (ch === '[' || ch === ']' || ch === '{' || ch === '}') {
      throw new YamlError(no, 'nested flow collections are not supported');
    } else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '' || parts.length > 0) parts.push(current.trim());
  if (parts.some((p) => p === '')) throw new YamlError(no, 'empty entry in a flow collection');
  return parts;
}

const INT = /^-?(0|[1-9][0-9]*)$/;
const FLOAT = /^-?(0|[1-9][0-9]*)\.[0-9]+$/;

function scalar(text: string, no: number): YamlValue {
  if (text.startsWith('"')) return doubleQuoted(text, no);
  if (text.startsWith("'")) return singleQuoted(text, no);
  if (/^[&*!|>%@`]/.test(text)) throw new YamlError(no, `unsupported YAML feature at '${text.slice(0, 12)}' (anchors, aliases, tags and block scalars are not allowed; quote the value)`);
  if (text.includes(': ') || text.endsWith(':') || text.includes(' #')) throw new YamlError(no, `ambiguous plain value '${text}'; quote it`);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (INT.test(text) || FLOAT.test(text)) return Number(text);
  return text;
}

function doubleQuoted(text: string, no: number): string {
  if (text.length < 2 || !text.endsWith('"')) throw new YamlError(no, 'malformed double-quoted string');
  const body = text.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch === '"') throw new YamlError(no, 'unescaped " inside a double-quoted string');
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    i += 1;
    if (next === '"' || next === '\\') out += next;
    else if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else throw new YamlError(no, `unsupported escape '\\${next ?? ''}'`);
  }
  return out;
}

function singleQuoted(text: string, no: number): string {
  if (text.length < 2 || !text.endsWith("'")) throw new YamlError(no, 'malformed single-quoted string');
  const body = text.slice(1, -1);
  if (/'(?!')/.test(body.replace(/''/g, ''))) throw new YamlError(no, "unescaped ' inside a single-quoted string");
  return body.replace(/''/g, "'");
}
