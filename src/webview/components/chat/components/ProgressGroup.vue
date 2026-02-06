<template>
  <div class="progress-group" :class="{ collapsed: item.collapsed }">
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
      <div class="action-item" v-for="action in item.actions" :key="action.id">
        <span class="action-status" :class="actionStatusClass(action.status)">
          <span v-if="action.status === 'running'" class="spinner"></span>
          <span v-else-if="action.status === 'success'">✓</span>
          <span v-else-if="action.status === 'error'">✗</span>
          <span v-else>○</span>
        </span>
        <span class="file-icon">{{ action.icon }}</span>
        <span class="action-text">
          <span class="filename">{{ action.text }}</span>
          <span v-if="action.detail" class="detail">, {{ action.detail }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ActionItem, ProgressItem } from '../../../scripts/core/types';

defineProps<{
  item: ProgressItem;
  toggleProgress: (item: ProgressItem) => void;
  progressStatus: (item: ProgressItem) => string;
  progressStatusClass: (item: ProgressItem) => Record<string, boolean>;
  actionStatusClass: (status: ActionItem['status']) => Record<string, boolean>;
}>();
</script>
