<template>
  <div class="settings-section" :class="{ active: activeSection === 'tools' }">
    <div class="settings-group">
      <h3>Available Tools</h3>
      <div class="tools-grid">
        <div class="tool-card" v-for="tool in tools" :key="tool.name">
          <div class="tool-header">
            <span class="tool-icon">{{ tool.icon }}</span>
            <span class="tool-name">{{ tool.name }}</span>
          </div>
          <p class="tool-desc">{{ tool.desc }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ToolItem } from '../../../scripts/core/settings';

defineProps<{
  activeSection: string;
  tools: ToolItem[];
}>();
</script>
