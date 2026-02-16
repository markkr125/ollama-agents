import { mount } from '@vue/test-utils';
import { describe, expect, test } from 'vitest';
import ContextFilesDisplay from '../../../src/webview/components/chat/components/ContextFilesDisplay.vue';
import type { ContextFileRef } from '../../../src/webview/scripts/core/types';

const explicitFile: ContextFileRef = { fileName: 'src/app.ts', kind: 'explicit' };
const implicitFile: ContextFileRef = { fileName: 'src/utils.ts', kind: 'implicit-file' };
const selectionFile: ContextFileRef = { fileName: 'src/main.ts', kind: 'implicit-selection', lineRange: 'L10-L25' };
const scssFile: ContextFileRef = { fileName: '_input.scss', kind: 'explicit' };
const vueFile: ContextFileRef = { fileName: 'App.vue', kind: 'explicit' };

function makeFiles(count: number): ContextFileRef[] {
  return Array.from({ length: count }, (_, i) => ({
    fileName: `file${i}.ts`,
    kind: 'explicit' as const
  }));
}

describe('ContextFilesDisplay', () => {
  test('renders nothing when files array is empty', () => {
    const wrapper = mount(ContextFilesDisplay, { props: { files: [] } });
    expect(wrapper.find('.context-files-display').exists()).toBe(false);
  });

  test('renders a chip for each file', () => {
    const files = [explicitFile, implicitFile, selectionFile];
    const wrapper = mount(ContextFilesDisplay, { props: { files } });

    const chips = wrapper.findAll('.context-file-chip:not(.overflow-toggle)');
    expect(chips).toHaveLength(3);
    expect(chips[0].text()).toContain('app.ts');
    expect(chips[1].text()).toContain('utils.ts');
    expect(chips[2].text()).toContain('main.ts');
  });

  // ─── File-type icons ─────────────────────────────────────────────

  test('shows TS icon for .ts files', () => {
    const wrapper = mount(ContextFilesDisplay, { props: { files: [explicitFile] } });
    const icon = wrapper.find('.file-icon');
    expect(icon.text()).toBe('TS');
    // JSDOM converts hex to rgb()
    expect(icon.attributes('style')).toContain('color:');
  });

  test('shows S icon for .scss files', () => {
    const wrapper = mount(ContextFilesDisplay, { props: { files: [scssFile] } });
    const icon = wrapper.find('.file-icon');
    expect(icon.text()).toBe('S');
    expect(icon.attributes('style')).toContain('color:');
  });

  test('shows V icon for .vue files', () => {
    const wrapper = mount(ContextFilesDisplay, { props: { files: [vueFile] } });
    const icon = wrapper.find('.file-icon');
    expect(icon.text()).toBe('V');
    expect(icon.attributes('style')).toContain('color:');
  });

  test('shows ≡ icon with accent color for selection kind', () => {
    const wrapper = mount(ContextFilesDisplay, { props: { files: [selectionFile] } });
    const icon = wrapper.find('.file-icon');
    expect(icon.text()).toBe('≡');
    expect(icon.attributes('style')).toContain('var(--accent)');
  });

  test('shows fallback icon for unknown extensions', () => {
    const file: ContextFileRef = { fileName: 'data.xyz' };
    const wrapper = mount(ContextFilesDisplay, { props: { files: [file] } });
    const icon = wrapper.find('.file-icon');
    expect(icon.text()).toBe('⬡');
  });

  // ─── Title attributes ────────────────────────────────────────────

  test('title includes lineRange when present', () => {
    const wrapper = mount(ContextFilesDisplay, { props: { files: [selectionFile] } });
    const chip = wrapper.find('.context-file-chip');
    expect(chip.attributes('title')).toBe('src/main.ts (L10-L25)');
  });

  test('title says "(implicit)" for implicit-file kind', () => {
    const wrapper = mount(ContextFilesDisplay, { props: { files: [implicitFile] } });
    const chip = wrapper.find('.context-file-chip');
    expect(chip.attributes('title')).toBe('src/utils.ts (implicit)');
  });

  test('title says "(selection)" for implicit-selection without lineRange', () => {
    const file: ContextFileRef = { fileName: 'foo.ts', kind: 'implicit-selection' };
    const wrapper = mount(ContextFilesDisplay, { props: { files: [file] } });
    const chip = wrapper.find('.context-file-chip');
    expect(chip.attributes('title')).toBe('foo.ts (selection)');
  });

  test('title is bare fileName for explicit files', () => {
    const wrapper = mount(ContextFilesDisplay, { props: { files: [explicitFile] } });
    const chip = wrapper.find('.context-file-chip');
    expect(chip.attributes('title')).toBe('src/app.ts');
  });

  // ─── Overflow behavior ──────────────────────────────────────────────

  test('shows all files when count <= 10 (no overflow toggle)', () => {
    const files = makeFiles(10);
    const wrapper = mount(ContextFilesDisplay, { props: { files } });
    const chips = wrapper.findAll('.context-file-chip');
    expect(chips).toHaveLength(10);
    expect(wrapper.find('.overflow-toggle').exists()).toBe(false);
  });

  test('shows only first 10 + overflow toggle when > 10 files', () => {
    const files = makeFiles(15);
    const wrapper = mount(ContextFilesDisplay, { props: { files } });
    const chips = wrapper.findAll('.context-file-chip');
    // 10 visible + 1 overflow toggle = 11
    expect(chips).toHaveLength(11);
    const toggle = wrapper.find('.overflow-toggle');
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain('+5');
  });

  test('clicking overflow toggle opens floating panel with all files', async () => {
    const files = makeFiles(12);
    const wrapper = mount(ContextFilesDisplay, { props: { files } });

    expect(wrapper.find('.context-files-overflow').exists()).toBe(false);

    await wrapper.find('.overflow-toggle').trigger('click');

    const overflow = wrapper.find('.context-files-overflow');
    expect(overflow.exists()).toBe(true);
    expect(overflow.find('.overflow-header').text()).toContain('12');
    const overflowChips = overflow.findAll('.context-file-chip');
    expect(overflowChips).toHaveLength(12);
  });

  test('clicking close button hides the overflow panel', async () => {
    const files = makeFiles(12);
    const wrapper = mount(ContextFilesDisplay, { props: { files } });

    await wrapper.find('.overflow-toggle').trigger('click');
    expect(wrapper.find('.context-files-overflow').exists()).toBe(true);

    await wrapper.find('.overflow-close').trigger('click');
    expect(wrapper.find('.context-files-overflow').exists()).toBe(false);
  });
});
