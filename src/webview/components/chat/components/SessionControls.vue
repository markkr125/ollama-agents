<template>
  <div v-if="currentMode === 'agent'" class="session-controls">
    <button class="session-controls-toggle" @click="$emit('update:expanded', !expanded)">
      <span class="codicon codicon-tools session-controls-icon"></span>
      <span class="session-controls-title">Session</span>
      <span class="session-controls-chevron" :class="{ expanded }">›</span>
    </button>
    <transition name="slide">
      <div v-if="expanded" class="session-controls-panel">
        <label class="session-control-option" @click.prevent="toggleAutoApproveCommands">
          <input type="checkbox" :checked="autoApproveCommands" />
          <span class="option-text">Auto-approve commands</span>
          <span class="option-hint">Skip approval for non-critical commands</span>
        </label>
        <label class="session-control-option" @click.prevent="toggleAutoApproveSensitiveEdits">
          <input type="checkbox" :checked="autoApproveSensitiveEdits" />
          <span class="option-text">Auto-approve sensitive edits</span>
          <span class="option-hint">Skip approval for sensitive file changes</span>
        </label>
        <div class="session-control-option explorer-model-picker">
          <span class="option-text">Explorer Model</span>
          <select
            class="explorer-select"
            :value="sessionExplorerModel"
            @change="onExplorerModelChange($event)"
          >
            <option value="">(Global Default)</option>
            <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
          </select>
          <span class="option-hint">Override the exploration model for this session</span>
        </div>
      </div>
    </transition>
  </div>

  <!-- Confirmation dialog for auto-approve commands -->
  <div
    v-if="currentMode === 'agent' && autoApproveConfirmVisible"
    class="auto-approve-confirm-overlay"
    @click.self="cancelAutoApproveCommands"
  >
    <div class="auto-approve-confirm-dialog">
      <div class="confirm-dialog-icon">⚠️</div>
      <div class="confirm-dialog-title">Enable Auto-Approve Commands?</div>
      <div class="confirm-dialog-message">
        Commands will run automatically without asking for approval.
        <strong>This can be risky</strong> as it allows the agent to execute terminal commands without your review.
        <br /><br />
        Critical commands (like <code>rm -rf</code>, <code>sudo</code>) will still require approval.
      </div>
      <div class="confirm-dialog-actions">
        <button class="approve-btn" @click="confirmAutoApproveCommands">Enable Auto-Approve</button>
        <button class="skip-btn" @click="cancelAutoApproveCommands">Cancel</button>
      </div>
    </div>
  </div>

  <!-- Confirmation dialog for auto-approve sensitive edits -->
  <div
    v-if="currentMode === 'agent' && autoApproveSensitiveEditsConfirmVisible"
    class="auto-approve-confirm-overlay"
    @click.self="cancelAutoApproveSensitiveEdits"
  >
    <div class="auto-approve-confirm-dialog">
      <div class="confirm-dialog-icon">⚠️</div>
      <div class="confirm-dialog-title">Enable Auto-Approve Sensitive Edits?</div>
      <div class="confirm-dialog-message">
        Edits to sensitive files (config files, secrets, etc.) will be applied automatically without review.
        <strong>This can be risky</strong> as it allows the agent to modify critical files without your approval.
        <br /><br />
        Make sure you trust the agent's changes before enabling this.
      </div>
      <div class="confirm-dialog-actions">
        <button class="approve-btn" @click="confirmAutoApproveSensitiveEdits">Enable Auto-Approve</button>
        <button class="skip-btn" @click="cancelAutoApproveSensitiveEdits">Cancel</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  currentMode: string;
  expanded: boolean;
  autoApproveCommands: boolean;
  autoApproveConfirmVisible: boolean;
  toggleAutoApproveCommands: () => void;
  confirmAutoApproveCommands: () => void;
  cancelAutoApproveCommands: () => void;
  autoApproveSensitiveEdits: boolean;
  autoApproveSensitiveEditsConfirmVisible: boolean;
  toggleAutoApproveSensitiveEdits: () => void;
  confirmAutoApproveSensitiveEdits: () => void;
  cancelAutoApproveSensitiveEdits: () => void;
  sessionExplorerModel: string;
  modelOptions: string[];
  setSessionExplorerModel: (model: string) => void;
}>();

defineEmits<{
  'update:expanded': [value: boolean];
}>();

function onExplorerModelChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  props.setSessionExplorerModel(value);
}
</script>
