<template>
  <div class="command-approval" :class="[`severity-${item.severity}`, `status-${item.status}`]">
    <div class="command-approval-header">
      <span class="command-approval-icon">⚠️</span>
      <span class="command-approval-title">Terminal Command</span>
      <span v-if="item.autoApproved" class="command-approval-tag">Auto-approved</span>
      <span class="command-approval-severity">{{ item.severity }}</span>
    </div>

    <div class="command-approval-command">
      <code>$ {{ item.command }}</code>
    </div>

    <div v-if="item.cwd" class="command-approval-detail">
      <span class="detail-label">Directory</span>
      <span class="detail-value">{{ item.cwd }}</span>
    </div>

    <div v-if="item.reason" class="command-approval-detail">
      <span class="detail-label">Reason</span>
      <span class="detail-value">{{ item.reason }}</span>
    </div>

    <div v-if="item.output" class="command-approval-output">
      <pre>{{ item.output }}</pre>
    </div>

    <div v-if="item.status === 'pending'" class="command-approval-actions">
      <button class="approve-btn" @click="onApprove(item.id)">Run (⌘↵)</button>
      <button class="skip-btn" @click="onSkip(item.id)">Skip (⎋)</button>
      <label class="command-approval-auto">
        <span>Auto-approve commands (session)</span>
        <div class="toggle" :class="{ on: autoApproveEnabled }" @click.stop="onToggleAutoApprove"></div>
      </label>
    </div>

    <div v-else class="command-approval-status">
      <span v-if="item.status === 'approved'" class="status-approved">✓ Approved</span>
      <span v-else class="status-skipped">✗ Skipped</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { CommandApprovalItem } from '../scripts/core/types';

defineProps<{
  item: CommandApprovalItem;
  onApprove: (id: string) => void;
  onSkip: (id: string) => void;
  autoApproveEnabled: boolean;
  onToggleAutoApprove: () => void;
}>();
</script>
