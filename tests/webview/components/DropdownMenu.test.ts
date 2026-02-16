import { mount } from '@vue/test-utils';
import { describe, expect, test } from 'vitest';
import DropdownMenu from '../../../src/webview/components/chat/components/DropdownMenu.vue';

const sampleItems = [
  { id: 'agent', icon: 'codicon-hubot', label: 'Agent', description: 'Autonomous agent' },
  { id: 'ask', icon: 'codicon-comment-discussion', label: 'Ask', description: 'Ask questions' },
  { id: 'sep', icon: '', label: '', separator: true },
  { id: 'edit', icon: 'codicon-edit', label: 'Edit', description: 'Edit code' },
];

const anchorRect = { top: 100, left: 50, bottom: 130, width: 200 };

// Stub Teleport so content renders inline instead of into document.body
const globalStubs = { Teleport: true };

describe('DropdownMenu', () => {
  test('renders all non-separator items as buttons', () => {
    const wrapper = mount(DropdownMenu, {
      props: { items: sampleItems, anchorRect },
      global: { stubs: globalStubs }
    });

    const buttons = wrapper.findAll('.dropdown-item');
    expect(buttons).toHaveLength(3); // agent, ask, edit (separator is not a button)
  });

  test('renders separator elements', () => {
    const wrapper = mount(DropdownMenu, {
      props: { items: sampleItems, anchorRect },
      global: { stubs: globalStubs }
    });

    expect(wrapper.find('.dropdown-separator').exists()).toBe(true);
  });

  test('marks active item with .active class', () => {
    const wrapper = mount(DropdownMenu, {
      props: { items: sampleItems, modelValue: 'ask', anchorRect },
      global: { stubs: globalStubs }
    });

    const activeItems = wrapper.findAll('.dropdown-item.active');
    expect(activeItems).toHaveLength(1);
    expect(activeItems[0].text()).toContain('Ask');
  });

  test('shows check mark on active item', () => {
    const wrapper = mount(DropdownMenu, {
      props: { items: sampleItems, modelValue: 'agent', anchorRect },
      global: { stubs: globalStubs }
    });

    const activeItem = wrapper.find('.dropdown-item.active');
    expect(activeItem.find('.codicon-check').exists()).toBe(true);
  });

  test('emits select on item click', async () => {
    const wrapper = mount(DropdownMenu, {
      props: { items: sampleItems, anchorRect },
      global: { stubs: globalStubs }
    });

    const buttons = wrapper.findAll('.dropdown-item');
    await buttons[1].trigger('click'); // click "Ask"

    expect(wrapper.emitted('select')).toEqual([['ask']]);
  });

  test('emits close on overlay click', async () => {
    const wrapper = mount(DropdownMenu, {
      props: { items: sampleItems, anchorRect },
      global: { stubs: globalStubs }
    });

    await wrapper.find('.dropdown-overlay').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  test('renders item descriptions', () => {
    const wrapper = mount(DropdownMenu, {
      props: { items: sampleItems, anchorRect },
      global: { stubs: globalStubs }
    });

    expect(wrapper.text()).toContain('Autonomous agent');
    expect(wrapper.text()).toContain('Ask questions');
  });

  test('renders item icons', () => {
    const wrapper = mount(DropdownMenu, {
      props: { items: sampleItems, anchorRect },
      global: { stubs: globalStubs }
    });

    expect(wrapper.find('.codicon-hubot').exists()).toBe(true);
    expect(wrapper.find('.codicon-comment-discussion').exists()).toBe(true);
  });
});
