<template>
  <!-- Flat rendering for file-write groups (any state) and completed file groups -->
  <div v-if="isFlatFileGroup" class="flat-file-actions">
    <div v-for="action in item.actions" :key="action.id" class="flat-action">
      <span class="action-status" :class="actionStatusClass(action.status)">
        <span v-if="action.status === 'running'" class="spinner"></span>
        <span v-else-if="action.status === 'success'">✓</span>
        <span v-else-if="action.status === 'error'">✗</span>
        <span v-else>○</span>
      </span>
      <span class="flat-verb">{{ getVerb(action) }}</span>
      <span v-if="getFileName(action)" class="flat-chevron">▸</span>
      <span
        class="flat-filename"
        @click.stop="action.filePath && handleOpenDiff(action.checkpointId, action.filePath)"
      >{{ getFileName(action) }}</span>
      <template v-if="action.detail">
        <span v-if="parseDiffStats(action.detail).adds" class="flat-stat-add">{{ parseDiffStats(action.detail).adds }}</span>
        <span v-if="parseDiffStats(action.detail).dels" class="flat-stat-del">{{ parseDiffStats(action.detail).dels }}</span>
      </template>
    </div>
  </div>

  <!-- Flat rendering for sub-agent actions (no collapsible group) -->
  <div v-else-if="isFlatSubagentGroup" class="flat-subagent-actions">
    <div v-for="action in item.actions" :key="action.id" class="flat-subagent-action">
      <span class="action-status" :class="actionStatusClass(action.status)">
        <span v-if="action.status === 'running'" class="spinner"></span>
        <span v-else-if="action.status === 'success'">✓</span>
        <span v-else-if="action.status === 'error'">✗</span>
        <span v-else>○</span>
      </span>
      <span class="subagent-icon">{{ action.icon }}</span>
      <span class="subagent-text">{{ action.text }}</span>
      <span v-if="action.detail" class="subagent-mode">{{ action.detail }}</span>
    </div>
  </div>

  <!-- Normal progress group rendering -->
  <div v-else class="progress-group" :class="{ collapsed: item.collapsed }">
    <div class="progress-header" @click="toggleProgress(item)">
      <span class="progress-chevron">▼</span>
      <span class="progress-status" :class="progressStatusClass(item)">
        <span v-if="progressStatus(item) === 'running'" class="spinner"></span>
        <span v-else-if="progressStatus(item) === 'success'">✓</span>
        <span v-else-if="progressStatus(item) === 'error'">✗</span>
        <span v-else>○</span>
      </span>
      <span class="progress-title">{{ item.title }}</span>
    </div>
    <div class="progress-actions">
      <div v-for="action in item.actions" :key="action.id" class="action-item" :class="{ 'has-listing': action.detail && hasListing(action.detail) }">
        <span class="action-status" :class="actionStatusClass(action.status)">
          <span v-if="action.status === 'running'" class="spinner"></span>
          <span v-else-if="action.status === 'success'">✓</span>
          <span v-else-if="action.status === 'error'">✗</span>
          <span v-else>○</span>
        </span>
        <span class="file-icon">{{ action.icon }}</span>
        <div class="action-text">
          <span
            class="filename"
            :class="{ clickable: !!action.filePath }"
            @click.stop="action.filePath && handleFileClick(action)"
          >{{ action.text }}</span>
          <template v-if="action.detail && hasListing(action.detail)">
            <span class="detail"> {{ getDetailSummary(action.detail) }}</span>
            <div class="action-listing tree-listing">
              <div
                v-for="(entry, i) in parseListing(action.detail)"
                :key="i"
                class="listing-row"
                :class="[entry.type, { clickable: true }]"
                :title="entry.fullPath"
                @click.stop="handleListingClick(entry)"
              >
                <span class="tree-connector">{{ i === parseListing(action.detail).length - 1 ? '└' : '├' }}</span>
                <span class="listing-icon">{{ entry.icon }}</span>
                <span class="listing-name">{{ entry.name }}</span>
                <span v-if="entry.size" class="listing-size">{{ entry.size }}</span>
              </div>
            </div>
          </template>
          <span v-else-if="action.detail" class="detail" :class="{ 'diff-stats': action.filePath }"> {{ action.detail }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { openFileChangeDiff, openWorkspaceFile, revealInExplorer } from '../../../scripts/core/actions';
import type { ActionItem, ProgressItem } from '../../../scripts/core/types';

const props = defineProps<{
  item: ProgressItem;
  toggleProgress: (item: ProgressItem) => void;
  progressStatus: (item: ProgressItem) => string;
  progressStatusClass: (item: ProgressItem) => Record<string, boolean>;
  actionStatusClass: (status: ActionItem['status']) => Record<string, boolean>;
}>();

/**
 * True when the group should render flat (no collapsible header):
 * - Write/modify/create groups in ANY state (running or done)
 * - Completed file-only groups with checkpoints
 */
const isFlatFileGroup = computed(() => {
  if (props.item.actions.length === 0) return false;
  // Only file-write groups render flat (by group title)
  return /\b(writ|modif|creat)/i.test(props.item.title);
});

/**
 * True when the group contains only sub-agent actions.
 * Sub-agent actions render flat with full task text visible.
 */
const isFlatSubagentGroup = computed(() => {
  if (props.item.actions.length === 0) return false;
  return /delegat|subtask|sub-?agent/i.test(props.item.title);
});

const getVerb = (action: ActionItem): string => {
  if (!action.filePath) return action.text;
  const filename = action.filePath.split('/').pop() || '';
  return action.text.replace(filename, '').trim();
};

const getFileName = (action: ActionItem): string => {
  return action.filePath?.split('/').pop() || '';
};

const parseDiffStats = (detail: string): { adds: string; dels: string } => {
  const match = detail.match(/^(\+\d+)\s*(-\d+)?$/);
  if (match) return { adds: match[1], dels: match[2] || '' };
  return { adds: '', dels: '' };
};

/** True when detail contains a multi-line listing (e.g. from list_files or search_workspace). */
const hasListing = (detail: string): boolean => detail.includes('\n');

/** First line of a multi-line detail (the summary text, without the basePath). */
const getDetailSummary = (detail: string): string => {
  const firstLine = detail.split('\n')[0];
  // Summary format: "count summary\tbasePath" — strip the tab + basePath
  const tabIdx = firstLine.indexOf('\t');
  return tabIdx >= 0 ? firstLine.substring(0, tabIdx) : firstLine;
};

/** Extract basePath from the summary line (tab-separated). */
const getBasePath = (detail: string): string => {
  const firstLine = detail.split('\n')[0];
  const tabIdx = firstLine.indexOf('\t');
  return tabIdx >= 0 ? firstLine.substring(tabIdx + 1) : '';
};

type ListingEntry = { icon: string; name: string; size: string; type: 'folder' | 'file'; fullPath: string };

/** Format bytes into a human-readable size string. */
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Parse listing lines into structured entries with icon, name, size, fullPath. */
const parseListing = (detail: string): ListingEntry[] => {
  const basePath = getBasePath(detail);
  return detail.split('\n').slice(1).filter(Boolean).map(line => {
    const isFolder = line.startsWith('📁');
    // Format: "📁 name" or "📄 name\tsize"
    const rest = line.replace(/^📁 |^📄 /, '');
    const tabIdx = rest.indexOf('\t');
    const name = tabIdx >= 0 ? rest.substring(0, tabIdx) : rest;
    const sizeStr = tabIdx >= 0 ? rest.substring(tabIdx + 1) : '';
    const sizeNum = sizeStr ? Number(sizeStr) : NaN;
    const fullPath = basePath ? `${basePath}/${name}` : name;
    return {
      icon: isFolder ? '📁' : '📄',
      name,
      size: !isNaN(sizeNum) ? formatSize(sizeNum) : sizeStr,
      type: isFolder ? 'folder' as const : 'file' as const,
      fullPath
    };
  });
};

const handleOpenDiff = (checkpointId: string | undefined, filePath: string) => {
  openFileChangeDiff(checkpointId || '', filePath);
};

const handleFileClick = (action: ActionItem) => {
  if (!action.filePath) return;
  if (action.checkpointId) {
    openFileChangeDiff(action.checkpointId, action.filePath);
  } else {
    openWorkspaceFile(action.filePath, action.startLine);
  }
};

const handleListingClick = (entry: ListingEntry) => {
  if (entry.type === 'folder') {
    revealInExplorer(entry.fullPath);
  } else {
    openWorkspaceFile(entry.fullPath);
  }
};
</script>
