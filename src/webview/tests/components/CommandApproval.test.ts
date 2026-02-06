import { mount } from '@vue/test-utils';
import { expect, test, vi } from 'vitest';
import CommandApproval from '../../components/chat/components/CommandApproval.vue';

test('pending status renders editable input and calls onApprove with edited command', async () => {
  const onApprove = vi.fn();
  const onSkip = vi.fn();
  const onToggleAutoApprove = vi.fn();

  const wrapper = mount(CommandApproval, {
    props: {
      item: {
        id: 'a1',
        type: 'commandApproval',
        command: 'echo hi',
        severity: 'medium',
        status: 'pending',
        timestamp: Date.now(),
        cwd: '/tmp'
      },
      onApprove,
      onSkip,
      autoApproveEnabled: false,
      onToggleAutoApprove
    }
  });

  const input = wrapper.get('input.command-approval-input');
  await input.setValue('echo edited');

  await wrapper.get('button.approve-btn').trigger('click');
  expect(onApprove).toHaveBeenCalledWith('a1', 'echo edited');
});

test('non-pending status renders code and no input', async () => {
  const wrapper = mount(CommandApproval, {
    props: {
      item: {
        id: 'a2',
        type: 'commandApproval',
        command: 'echo hi',
        severity: 'medium',
        status: 'approved',
        timestamp: Date.now(),
        cwd: ''
      },
      onApprove: vi.fn(),
      onSkip: vi.fn(),
      autoApproveEnabled: false,
      onToggleAutoApprove: vi.fn()
    }
  });

  expect(wrapper.find('input.command-approval-input').exists()).toBe(false);
  expect(wrapper.text()).toContain('$ echo hi');
});
