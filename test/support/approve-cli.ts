// 승인 CLI(apps/daemon/src/approve.ts)를 별도 프로세스로 실행한다.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const APPROVE_CLI = fileURLToPath(new URL('../../apps/daemon/src/approve.ts', import.meta.url));

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}

export function runApproveCli(args: string[], options: { socket: string; actor: string; stdin?: string; env?: Record<string, string> }): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [APPROVE_CLI, '--socket', options.socket, '--actor', options.actor, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(stdout.trim()) as Record<string, unknown>;
      } catch {
        json = null;
      }
      resolve({ code, stdout, stderr, json });
    });
    child.stdin.end(options.stdin ?? '');
  });
}
