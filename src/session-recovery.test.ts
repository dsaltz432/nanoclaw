import { describe, it, expect } from 'vitest';

import { redactContainerArgs } from './container-runner.js';
import { isSessionResumeFailure } from './index.js';

describe('isSessionResumeFailure', () => {
  // Verbatim error observed in groups/telegram_main/logs on 2026-08-25, which
  // repeated across six consecutive runs because the dead id was saved back.
  const REAL =
    'Claude Code returned an error result: No conversation found with session ID: 40db9834-2395-4609-a2a7-e9abe105e417';

  it('detects the SDK resume failure', () => {
    expect(isSessionResumeFailure(REAL)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(
      isSessionResumeFailure('no conversation found with session id: x'),
    ).toBe(true);
  });

  it('ignores unrelated errors so they keep their session', () => {
    for (const err of [
      'API Error: 529 overloaded_error',
      'Container exited with code 137',
      'Cannot read /workspace/extra/store/messages.db',
      'No conversation history available',
    ]) {
      expect(isSessionResumeFailure(err)).toBe(false);
    }
  });

  it('handles a missing error field', () => {
    expect(isSessionResumeFailure(undefined)).toBe(false);
    expect(isSessionResumeFailure('')).toBe(false);
  });
});

describe('redactContainerArgs', () => {
  // Shape taken from a real run log's "Container Args" line.
  const args = [
    'run',
    '-i',
    '--rm',
    '--name',
    'nanoclaw-telegram-main-1787665040575',
    '-e',
    'TZ=America/New_York',
    '-e',
    'ANTHROPIC_BASE_URL=http://host.docker.internal:3001',
    '-e',
    'SERPER_API_KEY=98df6cf6391de438281a55a6037196304d1fa39e',
    '-e',
    'GITHUB_TOKEN=github_pat_11AB6CFSI0twDwsWOrLLS3',
    '-e',
    'HOME=/home/node',
    '-v',
    '/Users/x/nanoclaw:/workspace/project:ro',
    'nanoclaw-agent:latest',
  ];

  it('masks credential values', () => {
    const out = redactContainerArgs(args).join(' ');
    expect(out).not.toContain('98df6cf6391de438281a55a6037196304d1fa39e');
    expect(out).not.toContain('github_pat_11AB6CFSI0twDwsWOrLLS3');
    expect(out).toContain('SERPER_API_KEY=<redacted:40>');
  });

  it('keeps allowlisted env vars readable for debugging', () => {
    const out = redactContainerArgs(args).join(' ');
    expect(out).toContain('TZ=America/New_York');
    expect(out).toContain(
      'ANTHROPIC_BASE_URL=http://host.docker.internal:3001',
    );
    expect(out).toContain('HOME=/home/node');
  });

  it('leaves non-env arguments untouched', () => {
    const out = redactContainerArgs(args).join(' ');
    expect(out).toContain('--name nanoclaw-telegram-main-1787665040575');
    expect(out).toContain('-v /Users/x/nanoclaw:/workspace/project:ro');
    expect(out.endsWith('nanoclaw-agent:latest')).toBe(true);
  });

  it('masks an unknown env var by default', () => {
    const out = redactContainerArgs(['-e', 'NEW_SECRET_KEY=abc123']).join(' ');
    expect(out).toBe('-e NEW_SECRET_KEY=<redacted:6>');
  });

  it('does not treat a bare KEY=value as an env var', () => {
    // Only the token immediately following `-e` is an env assignment.
    const out = redactContainerArgs(['--label', 'owner=nanoclaw']).join(' ');
    expect(out).toBe('--label owner=nanoclaw');
  });
});
