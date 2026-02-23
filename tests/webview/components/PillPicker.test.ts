import { mount } from '@vue/test-utils';
import { describe, expect, test, vi } from 'vitest';
import PillPicker from '../../../src/webview/components/chat/components/input/PillPicker.vue';

// DropdownMenu uses Teleport — stub it to render inline
vi.mock('../../../src/webview/components/chat/components/input/DropdownMenu.vue', () => ({
  default: {
    name: 'DropdownMenu',
    props: ['items', 'modelValue', 'anchorRect'],
    emits: ['select', 'close'],
    template: `
      <div class="mock-dropdown">
        <button
          v-for="item in items"
          :key="item.id"
          class="mock-dropdown-item"
          :data-id="item.id"
          @click="$emit('select', item.id)"
        >{{ item.label }}</button>
      </div>
    `
  }
}));

const sampleItems = [
  { id: 'agent', icon: 'codicon-hubot', label: 'Agent' },
  { id: 'ask', icon: 'codicon-comment-discussion', label: 'Ask' },
  { id: 'edit', icon: 'codicon-edit', label: 'Edit' }
];

describe('PillPicker', () => {
  test('renders selected item label', () => {
    const wrapper = mount(PillPicker, {
      props: { items: sampleItems, modelValue: 'ask', icon: 'codicon-server' }
    });

    expect(wrapper.find('.pill-label').text()).toBe('Ask');
  });

  test('renders placeholder when no item matches', () => {
    const wrapper = mount(PillPicker, {
      props: { items: sampleItems, modelValue: 'unknown', placeholder: 'Select...' }
    });

    expect(wrapper.find('.pill-label').text()).toBe('Select...');
  });

  test('opens dropdown on click and emits update on select', async () => {
    const wrapper = mount(PillPicker, {
      props: { items: sampleItems, modelValue: 'agent' },
      attachTo: document.body // needed for getBoundingClientRect
    });

    // Initially no dropdown
    expect(wrapper.find('.mock-dropdown').exists()).toBe(false);

    // Click pill button to open
    await wrapper.find('.pill-btn').trigger('click');
    expect(wrapper.find('.mock-dropdown').exists()).toBe(true);

    // Click an item in dropdown
    await wrapper.find('.mock-dropdown-item[data-id="edit"]').trigger('click');
    expect(wrapper.emitted('update:modelValue')).toEqual([['edit']]);
  });

  test('closes dropdown on second click', async () => {
    const wrapper = mount(PillPicker, {
      props: { items: sampleItems, modelValue: 'agent' },
      attachTo: document.body
    });

    await wrapper.find('.pill-btn').trigger('click');
    expect(wrapper.find('.mock-dropdown').exists()).toBe(true);

    await wrapper.find('.pill-btn').trigger('click');
    expect(wrapper.find('.mock-dropdown').exists()).toBe(false);
  });

  test('shows icon when provided', () => {
    const wrapper = mount(PillPicker, {
      props: { items: sampleItems, modelValue: 'agent', icon: 'codicon-hubot' }
    });

    expect(wrapper.find('.codicon.codicon-hubot').exists()).toBe(true);
  });

  test('renders chevron', () => {
    const wrapper = mount(PillPicker, {
      props: { items: sampleItems, modelValue: 'agent' }
    });

    expect(wrapper.find('.codicon-chevron-down').exists()).toBe(true);
  });
});
