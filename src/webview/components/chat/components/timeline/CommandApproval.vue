<template>
  <details
    class="command-approval"
    :class="[`severity-${item.severity}`, `status-${item.status}`]"
    :open="item.status === 'pending'"
  >
    <summary class="command-approval-summary">
      <span class="command-approval-chevron">▼</span>
      <span v-if="item.status === 'pending' || item.status === 'running'" class="command-approval-status-icon">
        <span class="spinner"></span>
      </span>
      <span v-else-if="item.status === 'approved'" class="command-approval-status-icon approved">✓</span>
      <span v-else class="command-approval-status-icon skipped">✗</span>
      <span class="command-approval-summary-text">
        <span class="command-approval-icon" title="Terminal command">⚡</span>
        <code class="command-approval-cmd-preview">{{ item.command }}</code>
        <span v-if="item.autoApproved" class="command-approval-tag">Auto-approved</span>
        <span class="command-approval-severity" :title="severityTooltip">{{ item.severity }}</span>
      </span>
    </summary>

    <div class="command-approval-body">
      <div class="command-approval-command">
        <template v-if="item.status === 'pending'">
          <div class="command-approval-edit">
            <span class="command-prefix">$</span>
            <input
              v-model="editableCommand"
              class="command-approval-input"
              type="text"
              spellcheck="false"
            />
          </div>
        </template>
        <template v-else>
          <code>$ {{ item.command }}</code>
        </template>
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
        <button class="approve-btn" @click="onApprove(item.id, editableCommand)">Run (⌘↵)</button>
        <button class="skip-btn" @click="onSkip(item.id)">Skip (⎋)</button>
        <label class="command-approval-auto">
          <span>Auto-approve commands (session)</span>
          <div class="toggle" :class="{ on: autoApproveEnabled }" @click.stop="onToggleAutoApprove"></div>
        </label>
      </div>

      <div v-else-if="item.status !== 'running'" class="command-approval-status">
        <span v-if="item.status === 'approved'" class="status-approved">✓ Approved</span>
        <span v-else class="status-skipped">✗ Skipped</span>
      </div>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { CommandApprovalItem } from '../../../../scripts/core/types';

const props = defineProps<{
  item: CommandApprovalItem;
  onApprove: (id: string, command: string) => void;
  onSkip: (id: string) => void;
  autoApproveEnabled: boolean;
  onToggleAutoApprove: () => void;
}>();

const severityTooltips: Record<string, string> = {
  critical: 'Destructive or irreversible command (e.g. rm -rf, format)',
  high: 'Modifies system state or sensitive files',
  medium: 'Standard command that modifies the workspace'
};

const severityTooltip = computed(() => severityTooltips[props.item.severity] || props.item.severity);

const editableCommand = ref(props.item.command);

watch(
  () => props.item.command,
  (value) => {
    editableCommand.value = value;
  }
);
</script>
