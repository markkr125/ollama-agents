import { beforeEach, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-02-03T00:00:00Z'));
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

test('buildTimelineFromMessages keeps single assistant thread with tools embedded', async () => {
  const builder = await import('../../scripts/core/timelineBuilder');

  const messages = [
    { id: 'u1', role: 'user', content: 'hello' },
    { id: 'a1', role: 'assistant', content: 'Before tools', model: 'm1' },
    {
      id: 't1',
      role: 'tool',
      toolName: 'run_terminal_command',
      toolInput: JSON.stringify({ command: 'echo hi', cwd: '/tmp' }),
      content: 'Exit code: 0'
    },
    { id: 'a2', role: 'assistant', content: 'After tools', model: 'm1' }
  ];

  const timeline = builder.buildTimelineFromMessages(messages);
  expect(timeline.length).toBe(2);
  expect(timeline[0].type).toBe('message');
  expect(timeline[1].type).toBe('assistantThread');

  const thread = timeline[1] as any;
  expect(thread.contentBefore).toBe('Before tools');
  expect(thread.contentAfter).toBe('After tools');
  expect(thread.tools.length).toBe(2);

  const progress = thread.tools[0];
  expect(progress.type).toBe('progress');
  expect(progress.title).toBe('Running commands');

  const approval = thread.tools[1];
  expect(approval.type).toBe('commandApproval');
  expect(approval.command).toBe('echo hi');
  expect(approval.cwd).toBe('/tmp');
  expect(approval.exitCode).toBe(0);
});

test('buildTimelineFromMessages groups non-command tools with inferred title', async () => {
  const builder = await import('../../scripts/core/timelineBuilder');

  const messages = [
    { id: 'a1', role: 'assistant', content: 'Starting' },
    {
      id: 't1',
      role: 'tool',
      toolName: 'read_file',
      actionText: 'Read file',
      content: 'OK'
    },
    {
      id: 't2',
      role: 'tool',
      toolName: 'write_file',
      actionText: 'Write file',
      content: 'OK'
    }
  ];

  const timeline = builder.buildTimelineFromMessages(messages);
  const thread = timeline[0] as any;
  const group = thread.tools[0];
  expect(group.type).toBe('progress');
  expect(group.title).toBe('Modifying files');
  expect(group.actions.length).toBe(2);
});
