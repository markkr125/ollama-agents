import { mount } from '@vue/test-utils';
import { describe, expect, test, vi } from 'vitest';
import MarkdownBlock from '../../components/chat/components/MarkdownBlock.vue';

// Mock the formatMarkdown function so we don't pull in markdown-it
vi.mock('../../scripts/core/actions', () => ({
  formatMarkdown: (text: string) => `<p>${text}</p>`
}));

describe('MarkdownBlock', () => {
  test('renders markdown content via computed property', () => {
    const wrapper = mount(MarkdownBlock, {
      props: { content: 'Hello world' }
    });

    expect(wrapper.html()).toContain('<p>Hello world</p>');
    expect(wrapper.find('.markdown-body').exists()).toBe(true);
  });

  test('renders empty string when content is empty', () => {
    const wrapper = mount(MarkdownBlock, {
      props: { content: '' }
    });

    expect(wrapper.find('.markdown-body').exists()).toBe(true);
    expect(wrapper.html()).toContain('<p></p>');
  });

  test('updates when content prop changes', async () => {
    const wrapper = mount(MarkdownBlock, {
      props: { content: 'First' }
    });

    expect(wrapper.html()).toContain('<p>First</p>');

    await wrapper.setProps({ content: 'Second' });

    expect(wrapper.html()).toContain('<p>Second</p>');
    expect(wrapper.html()).not.toContain('<p>First</p>');
  });

  test('produces identical HTML when same content is set twice', async () => {
    const wrapper = mount(MarkdownBlock, {
      props: { content: 'Stable content' }
    });

    const htmlBefore = wrapper.html();

    // Setting the same content should produce identical output (computed caching)
    await wrapper.setProps({ content: 'Stable content' });

    expect(wrapper.html()).toBe(htmlBefore);
  });
});
