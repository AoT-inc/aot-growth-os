// 커넥터 프로세스 진입점 (ADR-0018 §1). 데몬이 `process.execPath` 로 띄우고 stdin/stdout 줄 단위 JSON 으로만 통신한다(wire.ts).
// 이 프로세스는 DB·policies·instance 에 접근하지 않고, 비밀값은 자기 환경 변수에서만 읽는다(데몬은 PATH 와 이 사이트의 비밀 변수만 넘긴다).
// 서버 도구 이름은 오너 선언 목록(`config.tools`)에 있을 때만 `tools/call` 로 보낸다(이중 방어: 호스트도 같은 목록으로 막는다).
// node: 내장 모듈과 이 폴더의 파일만 import 한다(.dependency-cruiser.cjs 의 mcp-connector-isolated).
import { Buffer } from 'node:buffer';
import process from 'node:process';

import { schemaHashOf } from './canonical.ts';
import { createMcpClient, type McpClient } from './client.ts';
import { createHttpTransport } from './http-transport.ts';
import { createRedactor, type Redactor } from './redact.ts';
import { createStdioTransport } from './stdio-transport.ts';
import type { Transport } from './transport.ts';
import {
  ConnectorFailure, DEFAULT_MAX_RESULT_BYTES, MAX_LINE_BYTES,
  type ConnectorConfig, type ConnectorError, type ConnectorNotice, type ConnectorRequest, type ConnectorResponse, type ConnectorToolInfo,
} from './wire.ts';

const write = (value: ConnectorResponse | ConnectorNotice): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const envValue = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

interface Runtime {
  config: ConnectorConfig;
  client: McpClient;
  redactor: Redactor;
  declared: ReadonlySet<string>;
}

/** 설정으로 전송·클라이언트를 만든다. 비밀 환경 변수가 비어 있으면 던진다(definite: 아무것도 보내지 않았다) */
function build(config: ConnectorConfig): Runtime {
  const secrets: string[] = [];
  const need = (name: string): string => {
    const value = envValue(name);
    if (value === undefined) throw new ConnectorFailure('config_invalid', `environment variable ${name} is not set for the connector`, true);
    secrets.push(value);
    return value;
  };
  let transport: Transport;
  if (config.transport.kind === 'http') {
    const headers: Record<string, string> = {};
    if (config.auth.kind === 'bearer') headers['authorization'] = `Bearer ${need(config.auth.token_env)}`;
    else if (config.auth.kind === 'header') headers[config.auth.header.toLowerCase()] = need(config.auth.value_env);
    transport = createHttpTransport({ url: config.transport.url, headers });
  } else {
    const env: Record<string, string> = {};
    if (process.env['PATH'] !== undefined) env['PATH'] = process.env['PATH'];
    for (const [serverName, variable] of Object.entries(config.env_from)) env[serverName] = need(variable);
    transport = createStdioTransport({ command: config.transport.command, args: config.transport.args, env });
  }
  const redactor = createRedactor(secrets);
  const client = createMcpClient({
    transport, redactor, maxResultBytes: config.max_result_bytes > 0 ? config.max_result_bytes : DEFAULT_MAX_RESULT_BYTES, onNotice: write,
  });
  return { config, client, redactor, declared: new Set(config.tools) };
}

const errorOf = (error: unknown, redactor: Redactor | null): ConnectorError => {
  const clean = (text: string): string => (redactor === null ? text : redactor.text(text)).slice(0, 500);
  if (error instanceof ConnectorFailure) return { code: error.code, message: clean(error.message), definite: error.definite };
  return { code: 'internal', message: clean(error instanceof Error ? error.message : 'unknown error'), definite: false };
};

function parseConfig(line: string): ConnectorConfig {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || value['type'] !== 'config' || !isRecord(value['transport']) || !isRecord(value['auth']) || !Array.isArray(value['tools'])) {
    throw new Error('the first line must be a connector config');
  }
  return value as unknown as ConnectorConfig;
}

async function main(): Promise<void> {
  let runtime: Runtime | null = null;
  let configError: ConnectorError | null = null;
  const inflight = new Map<number, { abort: AbortController; rpcId: number }>();

  const handle = async (request: ConnectorRequest): Promise<void> => {
    if (runtime === null) {
      write({ id: request.id, ok: false, error: configError ?? { code: 'config_invalid', message: 'the connector has no valid config', definite: true } });
      return;
    }
    const { client, config, declared, redactor } = runtime;
    try {
      if (request.op === 'list') {
        const server = await client.ready();
        const all = await client.listTools();
        const tools: ConnectorToolInfo[] = [];
        const undeclared: string[] = [];
        for (const tool of all) {
          if (declared.has(tool.name) || config.inspect === true) {
            tools.push(redactor.deep({ name: tool.name, input_schema_sha256: schemaHashOf(tool.inputSchema), input_schema: tool.inputSchema, annotations: tool.annotations }));
          } else {
            undeclared.push(redactor.text(tool.name).slice(0, 100)); // 선언 밖 도구는 이름만 센다(스키마·설명은 넘기지 않는다)
          }
        }
        write({ id: request.id, ok: true, tools, undeclared, server });
      } else if (request.op === 'call') {
        // 서버에 닿기 전에 막는다: 선언 밖 도구, 확인 명령 모드, 인자 형식
        if (config.inspect === true || typeof request.tool !== 'string' || !declared.has(request.tool)) {
          write({ id: request.id, ok: false, error: { code: 'undeclared_tool', message: 'the tool is not declared by the owner', definite: true } });
          return;
        }
        if (!isRecord(request.arguments)) {
          write({ id: request.id, ok: false, error: { code: 'invalid_arguments', message: 'arguments must be an object', definite: true } });
          return;
        }
        const entry = { abort: new AbortController(), rpcId: 0 };
        inflight.set(request.id, entry);
        try {
          const result = await client.callTool(request.tool, request.arguments, {
            signal: entry.abort.signal, retrySafe: request.retry_safe === true, onRequestId: (id) => { entry.rpcId = id; },
          });
          write({ id: request.id, ok: true, result });
        } finally {
          inflight.delete(request.id);
        }
      } else {
        const entry = inflight.get(request.target_id);
        if (entry !== undefined) {
          if (entry.rpcId > 0) await client.cancel(entry.rpcId, 'cancelled by the host');
          entry.abort.abort(new Error('cancelled by the host'));
        }
        write({ id: request.id, ok: true });
      }
    } catch (error) {
      write({ id: request.id, ok: false, error: errorOf(error, redactor) });
    }
  };

  const onLine = (line: string): void => {
    if (line.trim() === '') return;
    if (runtime === null && configError === null) {
      try {
        runtime = build(parseConfig(line));
      } catch (error) {
        configError = errorOf(error, null);
        process.stderr.write(`connector config error: ${configError.message}\n`);
      }
      return;
    }
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(request) || typeof request['id'] !== 'number' || typeof request['op'] !== 'string') return;
    void handle(request as unknown as ConnectorRequest);
  };

  let buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) break;
      const line = buffer.subarray(0, newline).toString('utf8');
      buffer = buffer.subarray(newline + 1);
      onLine(line);
    }
    if (buffer.length > MAX_LINE_BYTES) process.exit(3);
  });
  const shutdown = (): void => {
    const closing = runtime?.client.close() ?? Promise.resolve();
    void closing.catch(() => undefined).finally(() => process.exit(0));
  };
  process.stdin.on('end', shutdown);
  process.once('SIGTERM', shutdown);
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`connector unhandled rejection: ${reason instanceof Error ? reason.message : 'unknown'}\n`);
  });
}

await main();
