<template>
  <!-- Flat rendering for completed file-only groups -->
  <div v-if="isCompletedFileGroup" class="flat-file-actions">
    <div v-for="action in item.actions" :key="action.id" class="flat-action">
      <span class="action-status" :class="actionStatusClass(action.status)">
        <span v-if="action.status === 'success'">✓</span>
        <span v-else-if="action.status === 'error'">✗</span>
        <span v-else>○</span>
      </span>
      <span class="flat-verb">{{ getVerb(action) }}</span>
      <span class="flat-chevron">▸</span>
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
      <div v-for="action in item.actions" :key="action.id" class="action-item">
        <span class="action-status" :class="actionStatusClass(action.status)">
          <span v-if="action.status === 'running'" class="spinner"></span>
          <span v-else-if="action.status === 'success'">✓</span>
          <span v-else-if="action.status === 'error'">✗</span>
          <span v-else>○</span>
        </span>
        <span class="file-icon">{{ action.icon }}</span>
        <span class="action-text">
          <span
            class="filename"
            :class="{ clickable: !!action.filePath }"
            @click.stop="action.filePath && handleOpenDiff(action.checkpointId, action.filePath)"
          >{{ action.text }}</span>
          <span v-if="action.detail" class="detail" :class="{ 'diff-stats': action.filePath }"> {{ action.detail }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { openFileChangeDiff } from '../../../scripts/core/actions';
import type { ActionItem, ProgressItem } from '../../../scripts/core/types';

const props = defineProps<{
  item: ProgressItem;
  toggleProgress: (item: ProgressItem) => void;
  progressStatus: (item: ProgressItem) => string;
  progressStatusClass: (item: ProgressItem) => Record<string, boolean>;
  actionStatusClass: (status: ActionItem['status']) => Record<string, boolean>;
}>();

/** True when the group is done and every action is a file edit (has filePath). Renders flat. */
const isCompletedFileGroup = computed(() =>
  props.item.status === 'done' &&
  props.item.actions.length > 0 &&
  props.item.actions.every(a => a.filePath)
);

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
  return { adds: detail, dels: '' };
};

const handleOpenDiff = (checkpointId: string | undefined, filePath: string) => {
  openFileChangeDiff(checkpointId || '', filePath);
};
</script>
