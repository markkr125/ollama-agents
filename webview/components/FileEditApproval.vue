<template>
  <div class="file-approval" :class="[`severity-${item.severity}`, `status-${item.status}`]">
    <div class="file-approval-header">
      <span class="file-approval-icon">⚠️</span>
      <span class="file-approval-title">Sensitive File Edit</span>
      <span v-if="item.autoApproved" class="file-approval-tag">Auto-approved</span>
      <span class="file-approval-severity">{{ item.severity }}</span>
    </div>

    <div class="file-approval-path">
      <span class="detail-label">File</span>
      <span class="detail-value">{{ item.filePath }}</span>
    </div>

    <div v-if="item.reason" class="file-approval-path">
      <span class="detail-label">Reason</span>
      <span class="detail-value">{{ item.reason }}</span>
    </div>

    <div class="file-approval-diff" v-if="item.diffHtml">
      <div :class="diffThemeClass" v-html="item.diffHtml"></div>
    </div>

    <div v-if="item.status === 'pending'" class="file-approval-actions">
      <button class="approve-btn" @click="onApprove(item.id)">Allow</button>
      <button class="skip-btn" @click="onSkip(item.id)">Skip</button>
      <button class="btn btn-secondary" @click="onOpenDiff(item.id)">View Full Diff</button>
      <label class="file-approval-auto">
        <span>Auto-approve sensitive edits (session)</span>
        <div class="toggle" :class="{ on: autoApproveEnabled }" @click.stop="onToggleAutoApprove"></div>
      </label>
    </div>

    <div v-else class="file-approval-status">
      <span v-if="item.status === 'approved'" class="status-approved">✓ Approved</span>
      <span v-else class="status-skipped">✗ Skipped</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { FileEditApprovalItem } from '../scripts/core/types';

const props = defineProps<{
  item: FileEditApprovalItem;
  onApprove: (id: string) => void;
  onSkip: (id: string) => void;
  onOpenDiff: (id: string) => void;
  autoApproveEnabled: boolean;
  onToggleAutoApprove: () => void;
}>();

const diffThemeClass = computed(() => {
  const background = getComputedStyle(document.documentElement)
    .getPropertyValue('--vscode-editor-background')
    .trim();
  if (!background) return '';
  const rgb = background.match(/#([0-9a-f]{6})/i);
  if (!rgb) return '';
  const hex = rgb[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5 ? 'd2h-dark-color-scheme' : '';
});
</script>
