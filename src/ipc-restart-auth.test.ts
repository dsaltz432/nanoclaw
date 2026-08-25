import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub child_process before importing ipc.ts so the handler can never actually
// bounce a launchd service during a test run.
const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { _initTestDatabase, setRegisteredGroup } = await import('./db.js');
const { processTaskIpc } = await import('./ipc.js');

const MAIN_GROUP = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};
const OTHER_GROUP = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let deps: any;

beforeEach(() => {
  _initTestDatabase();
  execFileMock.mockClear();
  const groups: Record<string, any> = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
  };
  setRegisteredGroup('main@g.us', MAIN_GROUP as never);
  setRegisteredGroup('other@g.us', OTHER_GROUP as never);
  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: () => {},
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
  };
});

describe('restart_service authorization', () => {
  // Restarting com.nanoclaw tears down every in-flight container across all
  // groups. This verb was the only one in the IPC switch with no auth check,
  // which made it a denial-of-service reachable by any group — including ones
  // whose agents read untrusted third-party content.
  it('non-main group cannot restart nanoclaw', async () => {
    await processTaskIpc(
      { type: 'restart_service', service: 'nanoclaw' } as never,
      'other-group',
      false,
      deps,
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('non-main group cannot restart the dashboard', async () => {
    await processTaskIpc(
      { type: 'restart_service', service: 'dashboard' } as never,
      'other-group',
      false,
      deps,
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('main group can restart an allowed service', async () => {
    await processTaskIpc(
      { type: 'restart_service', service: 'dashboard' } as never,
      'whatsapp_main',
      true,
      deps,
    );
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [bin, args] = execFileMock.mock.calls[0];
    expect(bin).toBe('launchctl');
    expect(args).toContain('kickstart');
    expect(String(args)).toContain('com.nanoclaw.dashboard');
  });

  it('main group still cannot restart an unlisted service', async () => {
    await processTaskIpc(
      { type: 'restart_service', service: 'sshd' } as never,
      'whatsapp_main',
      true,
      deps,
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
