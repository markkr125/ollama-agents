import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-02-03T00:00:00Z'));
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildTimelineFromMessages - block-based structure', () => {
  test('creates user message as separate timeline item', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');
    const messages = [{ id: 'u1', role: 'user', content: 'hello' }];
    const timeline = builder.buildTimelineFromMessages(messages);

    expect(timeline.length).toBe(1);
    expect(timeline[0].type).toBe('message');
    expect(timeline[0].role).toBe('user');
    expect((timeline[0] as any).content).toBe('hello');
  });

  test('creates assistant thread with text block', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');
    const messages = [
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'assistant', content: 'Hi there!', model: 'test-model' }
    ];
    const timeline = builder.buildTimelineFromMessages(messages);

    expect(timeline.length).toBe(2);
    expect(timeline[1].type).toBe('assistantThread');

    const thread = timeline[1] as any;
    expect(thread.blocks.length).toBe(1);
    expect(thread.blocks[0].type).toBe('text');
    expect(thread.blocks[0].content).toBe('Hi there!');
    expect(thread.model).toBe('test-model');
  });

  test('merges consecutive assistant messages into one thread', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');
    const messages = [
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'assistant', content: 'Part 1' },
      { id: 'a2', role: 'assistant', content: 'Part 2' }
    ];
    const timeline = builder.buildTimelineFromMessages(messages);

    expect(timeline.length).toBe(2);
    const thread = timeline[1] as any;
    expect(thread.blocks.length).toBe(1);
    expect(thread.blocks[0].content).toBe('Part 1\n\nPart 2');
  });

  test('user message resets thread - creates new thread for next assistant', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');
    const messages = [
      { id: 'u1', role: 'user', content: 'first' },
      { id: 'a1', role: 'assistant', content: 'response 1' },
      { id: 'u2', role: 'user', content: 'second' },
      { id: 'a2', role: 'assistant', content: 'response 2' }
    ];
    const timeline = builder.buildTimelineFromMessages(messages);

    expect(timeline.length).toBe(4);
    expect(timeline[0].type).toBe('message');
    expect(timeline[1].type).toBe('assistantThread');
    expect(timeline[2].type).toBe('message');
    expect(timeline[3].type).toBe('assistantThread');
  });
});

describe('buildTimelineFromMessages - UI event replay', () => {
  const makeUiEvent = (id: string, eventType: string, payload: any) => ({
    id,
    role: 'tool',
    toolName: '__ui__',
    toolOutput: JSON.stringify({ eventType, payload })
  });

  test('startProgressGroup creates progress item in tools block', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');
    const messages = [
      { id: 'u1', role: 'user', content: 'do something' },
      { id: 'a1', role: 'assistant', content: 'Working on it' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Running commands' })
    ];
    const timeline = builder.buildTimelineFromMessages(messages);

    const thread = timeline[1] as any;
    expect(thread.blocks.length).toBe(2);
    expect(thread.blocks[0].type).toBe('text');
    expect(thread.blocks[1].type).toBe('tools');
    expect(thread.blocks[1].tools.length).toBe(1);

    const progress = thread.blocks[1].tools[0];
    expect(progress.type).toBe('progress');
    expect(progress.title).toBe('Running commands');
    expect(progress.status).toBe('running');
  });

  test('showToolAction adds action to current progress group', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');
    const messages = [
      { id: 'a1', role: 'assistant', content: 'Working' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Analyzing code' }),
      makeUiEvent('ui2', 'showToolAction', {
        status: 'success',
        icon: '📄',
        text: 'Read file',
        detail: 'package.json, 50 lines'
      })
    ];
    const timeline = builder.buildTimelineFromMessages(messages);

    const thread = timeline[0] as any;
    const progress = thread.blocks[1].tools[0];
    expect(progress.actions.length).toBe(1);
    expect(progress.actions[0].status).toBe('success');
    expect(progress.actions[0].text).toBe('Read file');
    expect(progress.actions[0].detail).toBe('package.json, 50 lines');
  });

  test('finishProgressGroup marks group as done and collapsed', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');
    const messages = [
      { id: 'a1', role: 'assistant', content: 'Working' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Analyzing code' }),
      makeUiEvent('ui2', 'showToolAction', { status: 'success', text: 'Read file' }),
      makeUiEvent('ui3', 'finishProgressGroup', {})
    ];
    const timeline = builder.buildTimelineFromMessages(messages);

    const thread = timeline[0] as any;
    const progress = thread.blocks[1].tools[0];
    expect(progress.status).toBe('done');
    expect(progress.collapsed).toBe(true);
  });

  test('finishProgressGroup marks group as error if any action has error', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');
    const messages = [
      { id: 'a1', role: 'assistant', content: 'Working' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Running' }),
      makeUiEvent('ui2', 'showToolAction', { status: 'success', text: 'OK' }),
      makeUiEvent('ui3', 'showToolAction', { status: 'error', text: 'Failed' }),
      makeUiEvent('ui4', 'finishProgressGroup', {})
    ];
    const timeline = builder.buildTimelineFromMessages(messages);

    const thread = timeline[0] as any;
    const progress = thread.blocks[1].tools[0];
    expect(progress.status).toBe('error');
  });
});

describe('buildTimelineFromMessages - command approval flow', () => {
  const makeUiEvent = (id: string, eventType: string, payload: any) => ({
    id,
    role: 'tool',
    toolName: '__ui__',
    toolOutput: JSON.stringify({ eventType, payload })
  });

  test('requestToolApproval adds action to progress group AND approval card', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');
    const messages = [
      { id: 'a1', role: 'assistant', content: 'Running command' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Running commands' }),
      makeUiEvent('ui2', 'requestToolApproval', {
        id: 'approval_123',
        command: 'npm install',
        cwd: '/project',
        severity: 'medium',
        reason: 'Installs packages'
      })
    ];
    const timeline = builder.buildTimelineFromMessages(messages);

    const thread = timeline[0] as any;
    const toolsBlock = thread.blocks[1];

    // Progress group should have action
    const progress = toolsBlock.tools[0];
    expect(progress.type).toBe('progress');
    expect(progress.actions.length).toBe(1);
    expect(progress.actions[0].text).toBe('Run command');
    expect(progress.actions[0].detail).toBe('Awaiting approval');
    expect(progress.actions[0].status).toBe('running');

    // Approval card should exist
    const approval = toolsBlock.tools[1];
    expect(approval.type).toBe('commandApproval');
    expect(approval.id).toBe('approval_123');
    expect(approval.command).toBe('npm install');
    expect(approval.status).toBe('pending');
  });

  test('toolApprovalResult updates action in progress group AND approval card', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');
    const messages = [
      { id: 'a1', role: 'assistant', content: 'Running command' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Running commands' }),
      makeUiEvent('ui2', 'requestToolApproval', {
        id: 'approval_123',
        command: 'npm install',
        cwd: '/project'
      }),
      makeUiEvent('ui3', 'toolApprovalResult', {
        approvalId: 'approval_123',
        status: 'approved',
        command: 'npm install papaparse',
        output: 'up to date\nExit code: 0',
        exitCode: 0
      })
    ];
    const timeline = builder.buildTimelineFromMessages(messages);

    const thread = timeline[0] as any;
    const toolsBlock = thread.blocks[1];

    // Progress group action should be updated to success
    const progress = toolsBlock.tools[0];
    expect(progress.actions[0].status).toBe('success');
    expect(progress.actions[0].detail).toBe('npm install papaparse');

    // Approval card should be updated
    const approval = toolsBlock.tools[1];
    expect(approval.status).toBe('approved');
    expect(approval.command).toBe('npm install papaparse');
    expect(approval.exitCode).toBe(0);
    expect(approval.output).toContain('Exit code: 0');
  });

  test('toolApprovalResult with skipped status marks action as error', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');
    const messages = [
      { id: 'a1', role: 'assistant', content: 'Running command' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Running commands' }),
      makeUiEvent('ui2', 'requestToolApproval', {
        id: 'approval_123',
        command: 'rm -rf /'
      }),
      makeUiEvent('ui3', 'toolApprovalResult', {
        approvalId: 'approval_123',
        status: 'skipped',
        output: 'Command skipped by user.'
      })
    ];
    const timeline = builder.buildTimelineFromMessages(messages);

    const thread = timeline[0] as any;
    const progress = thread.blocks[1].tools[0];
    const approval = thread.blocks[1].tools[1];

    expect(progress.actions[0].status).toBe('error');
    expect(progress.status).toBe('error');
    expect(approval.status).toBe('skipped');
  });
});

describe('buildTimelineFromMessages - full workflow matching live/history', () => {
  const makeUiEvent = (id: string, eventType: string, payload: any) => ({
    id,
    role: 'tool',
    toolName: '__ui__',
    toolOutput: JSON.stringify({ eventType, payload })
  });

  test('complete command execution flow produces identical structure', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');

    // Simulate the exact message sequence from a real session:
    // User asks to install package, agent runs npm install
    const messages = [
      { id: 'u1', role: 'user', content: 'add papaparse npm package' },
      { id: 'a1', role: 'assistant', content: '' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Running commands' }),
      makeUiEvent('ui2', 'requestToolApproval', {
        id: 'approval_abc',
        command: 'npm install papaparse',
        cwd: '/home/user/project',
        severity: 'medium',
        reason: 'Command requires approval'
      }),
      makeUiEvent('ui3', 'toolApprovalResult', {
        approvalId: 'approval_abc',
        status: 'approved',
        command: 'npm install papaparse',
        output: 'up to date, audited 108 packages\nExit code: 0',
        exitCode: 0
      }),
      makeUiEvent('ui4', 'showToolAction', {
        status: 'success',
        icon: '⚡',
        text: 'Command completed',
        detail: 'exit 0'
      }),
      makeUiEvent('ui5', 'finishProgressGroup', {}),
      { id: 'a2', role: 'assistant', content: 'The package has been installed.' },
      makeUiEvent('ui6', 'startProgressGroup', { title: 'Analyzing code' }),
      makeUiEvent('ui7', 'showToolAction', {
        status: 'success',
        icon: '📄',
        text: 'Read package.json',
        detail: '21 lines'
      }),
      makeUiEvent('ui8', 'finishProgressGroup', {}),
      { id: 'a3', role: 'assistant', content: 'Package is ready to use.' }
    ];

    const timeline = builder.buildTimelineFromMessages(messages);

    // Should have: user message + assistant thread
    expect(timeline.length).toBe(2);
    expect(timeline[0].type).toBe('message');
    expect(timeline[1].type).toBe('assistantThread');

    const thread = timeline[1] as any;
    // Blocks: text, tools (running commands), text, tools (analyzing code), text
    expect(thread.blocks.length).toBe(5);

    // First tools block: Running commands
    const toolsBlock1 = thread.blocks[1];
    expect(toolsBlock1.type).toBe('tools');
    expect(toolsBlock1.tools.length).toBe(2); // progress + approval

    const progress1 = toolsBlock1.tools[0];
    expect(progress1.type).toBe('progress');
    expect(progress1.title).toBe('Running commands');
    expect(progress1.status).toBe('done');
    expect(progress1.collapsed).toBe(true);
    expect(progress1.actions.length).toBe(2); // Run command + Command completed

    expect(progress1.actions[0].text).toBe('Run command');
    expect(progress1.actions[0].status).toBe('success');
    expect(progress1.actions[1].text).toBe('Command completed');
    expect(progress1.actions[1].status).toBe('success');

    const approval = toolsBlock1.tools[1];
    expect(approval.type).toBe('commandApproval');
    expect(approval.command).toBe('npm install papaparse');
    expect(approval.status).toBe('approved');
    expect(approval.exitCode).toBe(0);

    // Second tools block: Analyzing code
    const toolsBlock2 = thread.blocks[3];
    expect(toolsBlock2.type).toBe('tools');
    expect(toolsBlock2.tools.length).toBe(1); // just progress

    const progress2 = toolsBlock2.tools[0];
    expect(progress2.type).toBe('progress');
    expect(progress2.title).toBe('Analyzing code');
    expect(progress2.status).toBe('done');
    expect(progress2.actions.length).toBe(1);
    expect(progress2.actions[0].text).toBe('Read package.json');
  });

  test('text after tools creates new text block', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');
    const messages = [
      { id: 'a1', role: 'assistant', content: 'Before' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Working' }),
      makeUiEvent('ui2', 'finishProgressGroup', {}),
      { id: 'a2', role: 'assistant', content: 'After' }
    ];
    const timeline = builder.buildTimelineFromMessages(messages);

    const thread = timeline[0] as any;
    expect(thread.blocks.length).toBe(3);
    expect(thread.blocks[0].type).toBe('text');
    expect(thread.blocks[0].content).toBe('Before');
    expect(thread.blocks[1].type).toBe('tools');
    expect(thread.blocks[2].type).toBe('text');
    expect(thread.blocks[2].content).toBe('After');
  });
});

describe('buildTimelineFromMessages - edge cases', () => {
  const makeUiEvent = (id: string, eventType: string, payload: any) => ({
    id,
    role: 'tool',
    toolName: '__ui__',
    toolOutput: JSON.stringify({ eventType, payload })
  });

  test('showToolAction without prior startProgressGroup creates implicit group', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');
    const messages = [
      { id: 'a1', role: 'assistant', content: 'Working' },
      makeUiEvent('ui1', 'showToolAction', { status: 'success', text: 'Did something' })
    ];
    const timeline = builder.buildTimelineFromMessages(messages);

    const thread = timeline[0] as any;
    const progress = thread.blocks[1].tools[0];
    expect(progress.type).toBe('progress');
    expect(progress.title).toBe('Working on task');
    expect(progress.actions.length).toBe(1);
  });

  test('toolApprovalResult for non-existent approval creates new approval card', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');
    const messages = [
      { id: 'a1', role: 'assistant', content: 'Working' },
      makeUiEvent('ui1', 'toolApprovalResult', {
        approvalId: 'orphan_approval',
        status: 'approved',
        command: 'echo hello',
        output: 'hello\nExit code: 0',
        exitCode: 0
      })
    ];
    const timeline = builder.buildTimelineFromMessages(messages);

    const thread = timeline[0] as any;
    const approval = thread.blocks[1].tools[0];
    expect(approval.type).toBe('commandApproval');
    expect(approval.id).toBe('orphan_approval');
    expect(approval.status).toBe('approved');
  });

  test('invalid JSON in __ui__ event is skipped gracefully', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');
    const messages = [
      { id: 'a1', role: 'assistant', content: 'Working' },
      { id: 'ui1', role: 'tool', toolName: '__ui__', toolOutput: 'not valid json' },
      makeUiEvent('ui2', 'showToolAction', { status: 'success', text: 'OK' })
    ];
    const timeline = builder.buildTimelineFromMessages(messages);

    const thread = timeline[0] as any;
    // Should still have the valid action
    expect(thread.blocks[1].tools[0].actions.length).toBe(1);
    expect(thread.blocks[1].tools[0].actions[0].text).toBe('OK');
  });

  test('empty messages returns empty timeline', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');
    const timeline = builder.buildTimelineFromMessages([]);
    expect(timeline.length).toBe(0);
  });
});

describe('buildTimelineFromMessages - file edit approval flow (CRITICAL: live/session parity)', () => {
  const makeUiEvent = (id: string, eventType: string, payload: any) => ({
    id,
    role: 'tool',
    toolName: '__ui__',
    toolOutput: JSON.stringify({ eventType, payload })
  });

  test('file edit with approval shows pending, running, then success actions', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');

    // This is the EXACT sequence that must be persisted for session to match live:
    // 1. startProgressGroup
    // 2. showToolAction pending (Awaiting approval)
    // 3. requestFileEditApproval
    // 4. showToolAction running (after approval, before write)
    // 5. fileEditApprovalResult
    // 6. showToolAction success (after write completes)
    // 7. finishProgressGroup
    const messages = [
      { id: 'a1', role: 'assistant', content: 'I will update the file.' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Writing files' }),
      makeUiEvent('ui2', 'showToolAction', {
        status: 'pending',
        icon: '✏️',
        text: 'Write package.json',
        detail: 'Awaiting approval'
      }),
      makeUiEvent('ui3', 'requestFileEditApproval', {
        id: 'file_edit_123',
        filePath: 'package.json',
        severity: 'high',
        reason: 'Matched sensitive pattern',
        diffHtml: '<div>diff content</div>'
      }),
      makeUiEvent('ui4', 'showToolAction', {
        status: 'running',
        icon: '✏️',
        text: 'Write package.json',
        detail: 'package.json'
      }),
      makeUiEvent('ui5', 'fileEditApprovalResult', {
        approvalId: 'file_edit_123',
        status: 'approved',
        autoApproved: false,
        filePath: 'package.json'
      }),
      makeUiEvent('ui6', 'showToolAction', {
        status: 'success',
        icon: '✏️',
        text: 'Wrote package.json',
        detail: ''
      }),
      makeUiEvent('ui7', 'finishProgressGroup', {})
    ];

    const timeline = builder.buildTimelineFromMessages(messages);

    const thread = timeline[0] as any;
    const toolsBlock = thread.blocks[1];
    const progress = toolsBlock.tools[0];

    // Progress group action should be complete after all transitions
    expect(progress.type).toBe('progress');
    expect(progress.title).toBe('Writing files');
    expect(progress.status).toBe('done');
    expect(progress.collapsed).toBe(true);

    // Should have exactly 1 action - pending→running→success all update the same action
    // (pending and running have same text, success updates last running)
    expect(progress.actions.length).toBe(1);
    expect(progress.actions[0].status).toBe('success');

    // File edit approval card should be present and approved
    const approval = toolsBlock.tools[1];
    expect(approval.type).toBe('fileEditApproval');
    expect(approval.id).toBe('file_edit_123');
    expect(approval.status).toBe('approved');
    expect(approval.filePath).toBe('package.json');
    expect(approval.severity).toBe('high');
  });

  test('file edit skipped shows error status', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');

    const messages = [
      { id: 'a1', role: 'assistant', content: 'I will update the file.' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Writing files' }),
      makeUiEvent('ui2', 'showToolAction', {
        status: 'pending',
        icon: '✏️',
        text: 'Write package.json',
        detail: 'Awaiting approval'
      }),
      makeUiEvent('ui3', 'requestFileEditApproval', {
        id: 'file_edit_456',
        filePath: 'package.json',
        severity: 'high',
        reason: 'Matched sensitive pattern'
      }),
      makeUiEvent('ui4', 'fileEditApprovalResult', {
        approvalId: 'file_edit_456',
        status: 'skipped',
        autoApproved: false,
        filePath: 'package.json'
      }),
      makeUiEvent('ui5', 'showToolAction', {
        status: 'error',
        icon: '✏️',
        text: 'Edit skipped',
        detail: 'Skipped by user'
      }),
      makeUiEvent('ui6', 'finishProgressGroup', {})
    ];

    const timeline = builder.buildTimelineFromMessages(messages);

    const thread = timeline[0] as any;
    const progress = thread.blocks[1].tools[0];
    const approval = thread.blocks[1].tools[1];

    expect(progress.status).toBe('error');
    expect(approval.status).toBe('skipped');
  });

  test('auto-approved file edit shows autoApproved flag', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');

    const messages = [
      { id: 'a1', role: 'assistant', content: 'Updating file.' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Writing files' }),
      makeUiEvent('ui2', 'showToolAction', {
        status: 'running',
        icon: '✏️',
        text: 'Write package.json',
        detail: 'package.json'
      }),
      makeUiEvent('ui3', 'fileEditApprovalResult', {
        approvalId: 'file_edit_auto',
        status: 'approved',
        autoApproved: true,
        filePath: 'package.json',
        severity: 'high',
        diffHtml: '<div>auto diff</div>'
      }),
      makeUiEvent('ui4', 'showToolAction', {
        status: 'success',
        icon: '✏️',
        text: 'Wrote package.json',
        detail: ''
      }),
      makeUiEvent('ui5', 'finishProgressGroup', {})
    ];

    const timeline = builder.buildTimelineFromMessages(messages);

    const thread = timeline[0] as any;
    const approval = thread.blocks[1].tools[1];

    expect(approval.type).toBe('fileEditApproval');
    expect(approval.autoApproved).toBe(true);
    expect(approval.status).toBe('approved');
  });
});

describe('CRITICAL: Live handler vs timelineBuilder parity', () => {
  /**
   * These tests verify that the same sequence of events produces
   * IDENTICAL structures whether processed by live handlers or timelineBuilder.
   *
   * This is critical for session history to match live chat exactly.
   */

  const makeUiEvent = (id: string, eventType: string, payload: any) => ({
    id,
    role: 'tool',
    toolName: '__ui__',
    toolOutput: JSON.stringify({ eventType, payload })
  });

  test('showToolAction updates existing pending action with same text', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');

    // Simulate: pending "Write file" → success "Write file" (same text)
    const messages = [
      { id: 'a1', role: 'assistant', content: '' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Test' }),
      makeUiEvent('ui2', 'showToolAction', {
        status: 'pending',
        icon: '✏️',
        text: 'Write file',
        detail: 'Awaiting'
      }),
      makeUiEvent('ui3', 'showToolAction', {
        status: 'success',
        icon: '✏️',
        text: 'Write file',
        detail: 'Done'
      })
    ];

    const timeline = builder.buildTimelineFromMessages(messages);

    const thread = timeline[0] as any;
    const progress = thread.blocks[1].tools[0];

    // Should have exactly 1 action (pending updated to success)
    expect(progress.actions.length).toBe(1);
    expect(progress.actions[0].status).toBe('success');
    expect(progress.actions[0].text).toBe('Write file');
    expect(progress.actions[0].detail).toBe('Done');
  });

  test('showToolAction with different text updates last pending action', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');

    // Simulate: pending "Write package.json" → success "Wrote package.json" (different text)
    const messages = [
      { id: 'a1', role: 'assistant', content: '' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Test' }),
      makeUiEvent('ui2', 'showToolAction', {
        status: 'pending',
        icon: '✏️',
        text: 'Write package.json',
        detail: 'Awaiting'
      }),
      makeUiEvent('ui3', 'showToolAction', {
        status: 'success',
        icon: '✏️',
        text: 'Wrote package.json',
        detail: ''
      })
    ];

    const timeline = builder.buildTimelineFromMessages(messages);

    const thread = timeline[0] as any;
    const progress = thread.blocks[1].tools[0];

    // Should have exactly 1 action (pending updated to success with new text)
    expect(progress.actions.length).toBe(1);
    expect(progress.actions[0].status).toBe('success');
    expect(progress.actions[0].text).toBe('Wrote package.json');
  });

  test('running action with same text updates pending, then success updates it', async () => {
    const builder = await import('../../scripts/core/timelineBuilder');

    // Simulate full flow: pending → running (same text, updates) → success (updates)
    const messages = [
      { id: 'a1', role: 'assistant', content: '' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Test' }),
      makeUiEvent('ui2', 'showToolAction', {
        status: 'pending',
        icon: '✏️',
        text: 'Write package.json',
        detail: 'Awaiting approval'
      }),
      makeUiEvent('ui3', 'showToolAction', {
        status: 'running',
        icon: '✏️',
        text: 'Write package.json',
        detail: 'package.json'
      }),
      makeUiEvent('ui4', 'showToolAction', {
        status: 'success',
        icon: '✏️',
        text: 'Wrote package.json',
        detail: ''
      }),
      makeUiEvent('ui5', 'finishProgressGroup', {})
    ];

    const timeline = builder.buildTimelineFromMessages(messages);

    const thread = timeline[0] as any;
    const progress = thread.blocks[1].tools[0];

    // Should have exactly 1 action:
    // pending → running (updates same) → success (updates)
    expect(progress.actions.length).toBe(1);
    expect(progress.actions[0].status).toBe('success');
    expect(progress.status).toBe('done');
  });
});
