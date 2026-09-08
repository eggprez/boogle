import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { Model } from '../settings.js';

/**
 * One plain completion through the Claude Code CLI: no tools, no streaming,
 * the whole answer back as a string. The overview streams (claude.ts); this
 * is for small structured questions such as "is this query about a place?".
 */
export async function askClaude(opts: { system: string; prompt: string; model: Model; timeoutMs?: number }): Promise<string> {
  const workDir = path.join(config.dataDir, 'work');
  await mkdir(workDir, { recursive: true }).catch(() => {});
  const args = [
    '-p',
    '--no-session-persistence',
    '--tools', '',
    '--output-format', 'json',
    '--max-turns', '1',
    '--model', opts.model,
    '--system-prompt', opts.system,
  ];
  // See claude.ts: --bare only authenticates with an API key.
  if (process.env.ANTHROPIC_API_KEY) args.splice(1, 0, '--bare');

  return new Promise((resolve, reject) => {
    const child = spawn(config.claudeBin, args, {
      cwd: workDir,
      env: {
        ...process.env,
        HOME: process.env.HOME || '/home/node',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CI: '1',
        TERM: 'dumb',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Claude CLI took longer than ${opts.timeoutMs ?? 30_000} ms`));
    }, opts.timeoutMs ?? 30_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // --output-format json prints one JSON object (the "result" message).
      const line = out
        .trim()
        .split('\n')
        .reverse()
        .find((l) => l.startsWith('{'));
      let msg: { result?: unknown; is_error?: boolean; subtype?: string } | null = null;
      try {
        msg = line ? JSON.parse(line) : null;
      } catch {
        msg = null;
      }
      if (msg && typeof msg.result === 'string' && !msg.is_error && (!msg.subtype || msg.subtype === 'success')) return resolve(msg.result);
      const why = (typeof msg?.result === 'string' && msg.result) || err.trim().split('\n').slice(-2).join(' ') || `Claude CLI exited with code ${code}`;
      reject(new Error(why.slice(0, 300)));
    });
    child.stdin.end(opts.prompt);
  });
}
