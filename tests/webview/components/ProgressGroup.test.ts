import { mount } from '@vue/test-utils';
import { describe, expect, test, vi } from 'vitest';
import ProgressGroup from '../../../src/webview/components/chat/components/ProgressGroup.vue';
import type { ActionItem, ProgressItem } from '../../../src/webview/scripts/core/types';

// Mock action imports used by the component
const mockOpenFileChangeDiff = vi.fn();
const mockOpenWorkspaceFile = vi.fn();
const mockRevealInExplorer = vi.fn();

vi.mock('../../../src/webview/scripts/core/actions', () => ({
  openFileChangeDiff: (...args: any[]) => mockOpenFileChangeDiff(...args),
  openWorkspaceFile: (...args: any[]) => mockOpenWorkspaceFile(...args),
  revealInExplorer: (...args: any[]) => mockRevealInExplorer(...args),
  formatMarkdown: (text: string) => `<p>${text}</p>`
}));

const defaultProps = {
  toggleProgress: vi.fn(),
  progressStatus: (item: ProgressItem) => item.status === 'done' ? 'success' : item.status,
  progressStatusClass: () => ({}),
  actionStatusClass: () => ({})
};

const makeAction = (overrides: Partial<ActionItem> = {}): ActionItem => ({
  id: `action_${Math.random()}`,
  status: 'success',
  icon: '📄',
  text: 'Read file',
  detail: null,
  ...overrides
});

const makeProgressItem = (overrides: Partial<ProgressItem> = {}, actions: ActionItem[] = []): ProgressItem => ({
  id: 'pg_1',
  type: 'progress',
  title: 'Working',
  status: 'done',
  collapsed: false,
  actions,
  ...overrides
});

describe('ProgressGroup', () => {

  // ─── CRITICAL REGRESSION: isCompletedFileGroup guard ────────────────

  describe('isCompletedFileGroup guard', () => {

    test('renders flat view for completed FILE EDIT actions (with checkpointId)', () => {
      const item = makeProgressItem({}, [
        makeAction({ filePath: 'src/a.ts', checkpointId: 'cp1', text: 'Edited a.ts' }),
        makeAction({ filePath: 'src/b.ts', checkpointId: 'cp1', text: 'Added b.ts' })
      ]);
      const wrapper = mount(ProgressGroup, { props: { item, ...defaultProps } });

      expect(wrapper.find('.flat-file-actions').exists()).toBe(true);
      expect(wrapper.find('.progress-group').exists()).toBe(false);
    });

    test('does NOT render flat view for read_file actions (no checkpointId)', () => {
      const item = makeProgressItem({}, [
        makeAction({ filePath: 'src/a.ts', text: 'Read a.ts', startLine: 1 }),
        makeAction({ filePath: 'src/b.ts', text: 'Read b.ts', startLine: 1 })
      ]);
      const wrapper = mount(ProgressGroup, { props: { item, ...defaultProps } });

      // MUST be normal progress group, NOT flat
      expect(wrapper.find('.flat-file-actions').exists()).toBe(false);
      expect(wrapper.find('.progress-group').exists()).toBe(true);
    });

    test('does NOT render flat view for running groups', () => {
      const item = makeProgressItem({ status: 'running' }, [
        makeAction({ filePath: 'src/a.ts', checkpointId: 'cp1', status: 'running' })
      ]);
      const wrapper = mount(ProgressGroup, { props: { item, ...defaultProps } });

      expect(wrapper.find('.flat-file-actions').exists()).toBe(false);
      expect(wrapper.find('.progress-group').exists()).toBe(true);
    });

    test('mixed read + write actions: renders flat only if ALL have checkpointId', () => {
      const item = makeProgressItem({}, [
        makeAction({ filePath: 'src/a.ts', checkpointId: 'cp1', text: 'Edited a.ts' }),
        makeAction({ filePath: 'src/b.ts', text: 'Read b.ts' }) // no checkpointId
      ]);
      const wrapper = mount(ProgressGroup, { props: { item, ...defaultProps } });

      // One action lacks checkpointId → normal group
      expect(wrapper.find('.flat-file-actions').exists()).toBe(false);
      expect(wrapper.find('.progress-group').exists()).toBe(true);
    });
  });

  // ─── File click handling ───────────────────────────────────────────

  describe('file click handling', () => {

    test('clicking action with checkpointId opens diff', async () => {
      const item = makeProgressItem({}, [
        makeAction({ filePath: 'src/x.ts', checkpointId: 'cp1', text: 'Edited x.ts' })
      ]);
      const wrapper = mount(ProgressGroup, { props: { item, ...defaultProps } });

      // In flat view, click the filename
      await wrapper.find('.flat-filename').trigger('click');
      expect(mockOpenFileChangeDiff).toHaveBeenCalledWith('cp1', 'src/x.ts');
    });

    test('clicking read action (no checkpointId) opens file at startLine', async () => {
      const item = makeProgressItem({}, [
        makeAction({ filePath: 'src/y.ts', text: 'Read y.ts', startLine: 42 })
      ]);
      const wrapper = mount(ProgressGroup, { props: { item, ...defaultProps } });

      // In normal progress view, click the filename
      await wrapper.find('.filename.clickable').trigger('click');
      expect(mockOpenWorkspaceFile).toHaveBeenCalledWith('src/y.ts', 42);
    });

    test('clicking read action without startLine opens file at undefined', async () => {
      const item = makeProgressItem({}, [
        makeAction({ filePath: 'src/z.ts', text: 'Read z.ts' })
      ]);
      const wrapper = mount(ProgressGroup, { props: { item, ...defaultProps } });

      await wrapper.find('.filename.clickable').trigger('click');
      expect(mockOpenWorkspaceFile).toHaveBeenCalledWith('src/z.ts', undefined);
    });
  });

  // ─── Tree listing rendering ────────────────────────────────────────

  describe('tree listing', () => {

    test('renders tree with connectors for list_files output', () => {
      const detail = '3 files\tmy/dir\n📁 subdir\n📄 file1.ts\t1024\n📄 file2.ts\t2048';
      const item = makeProgressItem({}, [
        makeAction({ text: 'Listed my/dir', detail })
      ]);
      const wrapper = mount(ProgressGroup, { props: { item, ...defaultProps } });

      const rows = wrapper.findAll('.listing-row');
      expect(rows.length).toBe(3); // subdir, file1, file2

      // Last row uses └, others use ├
      const connectors = wrapper.findAll('.tree-connector');
      expect(connectors[0].text()).toBe('├');
      expect(connectors[1].text()).toBe('├');
      expect(connectors[2].text()).toBe('└');
    });

    test('tree row has full path as title tooltip', () => {
      const detail = '1 file\tsrc\n📄 main.ts\t100';
      const item = makeProgressItem({}, [
        makeAction({ text: 'Listed src', detail })
      ]);
      const wrapper = mount(ProgressGroup, { props: { item, ...defaultProps } });

      const row = wrapper.find('.listing-row');
      expect(row.attributes('title')).toBe('src/main.ts');
    });

    test('clicking a folder entry calls revealInExplorer', async () => {
      const detail = '1 folder\tsrc\n📁 utils';
      const item = makeProgressItem({}, [
        makeAction({ text: 'Listed src', detail })
      ]);
      const wrapper = mount(ProgressGroup, { props: { item, ...defaultProps } });

      await wrapper.find('.listing-row.folder').trigger('click');
      expect(mockRevealInExplorer).toHaveBeenCalledWith('src/utils');
    });

    test('clicking a file entry calls openWorkspaceFile', async () => {
      const detail = '1 file\tsrc\n📄 main.ts\t500';
      const item = makeProgressItem({}, [
        makeAction({ text: 'Listed src', detail })
      ]);
      const wrapper = mount(ProgressGroup, { props: { item, ...defaultProps } });

      await wrapper.find('.listing-row.file').trigger('click');
      expect(mockOpenWorkspaceFile).toHaveBeenCalledWith('src/main.ts');
    });

    test('detail summary strips basePath from display', () => {
      const detail = '2 files, 1 folder\tmy/base/path\n📁 dir\n📄 a.ts\t100\n📄 b.ts\t200';
      const item = makeProgressItem({}, [
        makeAction({ text: 'Listed something', detail })
      ]);
      const wrapper = mount(ProgressGroup, { props: { item, ...defaultProps } });

      // The summary text should show "2 files, 1 folder" without the basePath
      const detailText = wrapper.find('.detail').text();
      expect(detailText).toBe('2 files, 1 folder');
      expect(detailText).not.toContain('my/base/path');
    });
  });

  // ─── Action rendering ─────────────────────────────────────────────

  describe('action rendering', () => {

    test('progress group shows title', () => {
      const item = makeProgressItem({ title: 'Reading config.ts' }, [
        makeAction({ text: 'Read config.ts' })
      ]);
      const wrapper = mount(ProgressGroup, { props: { item, ...defaultProps } });

      expect(wrapper.find('.progress-title').text()).toBe('Reading config.ts');
    });

    test('action items show text and detail', () => {
      const item = makeProgressItem({}, [
        makeAction({ text: 'Read main.ts', detail: 'lines 1–100' })
      ]);
      const wrapper = mount(ProgressGroup, { props: { item, ...defaultProps } });

      expect(wrapper.find('.filename').text()).toBe('Read main.ts');
      expect(wrapper.find('.detail').text()).toBe('lines 1–100');
    });

    test('has-listing class is applied when detail contains newlines', () => {
      const item = makeProgressItem({}, [
        makeAction({ text: 'Listed src', detail: '2 files\t\n📄 a.ts\n📄 b.ts' })
      ]);
      const wrapper = mount(ProgressGroup, { props: { item, ...defaultProps } });

      expect(wrapper.find('.has-listing').exists()).toBe(true);
    });

    test('has-listing class NOT applied for simple detail text', () => {
      const item = makeProgressItem({}, [
        makeAction({ text: 'Read x.ts', detail: 'lines 1–50' })
      ]);
      const wrapper = mount(ProgressGroup, { props: { item, ...defaultProps } });

      expect(wrapper.find('.has-listing').exists()).toBe(false);
    });
  });
});
