<template>
  <div class="settings-section" :class="{ active: activeSection === 'advanced' }">
    <div class="settings-group">
      <h3>DB Maintenance</h3>
      <div class="settings-item">
        <label class="settings-label">Sync Sessions</label>
        <div class="settings-desc">
          Ensures sessions deleted from SQLite are removed from LanceDB messages and vice versa.
        </div>
      </div>
      <button class="btn btn-primary" @click="runDbMaintenance">Run DB Maintenance</button>
      <div class="status-msg" :class="statusClass(dbMaintenanceStatus)">{{ dbMaintenanceStatus.message }}</div>
    </div>

    <div class="settings-group danger-zone">
      <h3>⚠️ Danger Zone</h3>
      <div class="settings-item">
        <label class="settings-label">Recreate Messages Table</label>
        <div class="settings-desc danger-desc">
          Completely deletes and recreates the messages table. Use this to fix schema errors like "Found field not in schema".
          <strong>WARNING: This will permanently delete all chat history!</strong>
        </div>
      </div>
      <button class="btn btn-danger" @click="confirmRecreateMessagesTable">Recreate Messages Table</button>
      <div class="status-msg" :class="statusClass(recreateMessagesStatus)">{{ recreateMessagesStatus.message }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { StatusMessage } from '../../../scripts/core/settings';

defineProps<{
  activeSection: string;
  runDbMaintenance: () => void;
  statusClass: (status: StatusMessage) => Record<string, boolean>;
  dbMaintenanceStatus: StatusMessage;
  confirmRecreateMessagesTable: () => void;
  recreateMessagesStatus: StatusMessage;
}>();
</script>
