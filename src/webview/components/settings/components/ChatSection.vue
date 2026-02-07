<template>
  <div class="settings-section" :class="{ active: activeSection === 'chat' }">
    <div class="settings-group">
      <h3>Chat Settings</h3>
      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-label">Stream Responses</span>
          <span class="toggle-desc">Show responses as they are generated</span>
        </div>
        <div class="toggle" :class="{ on: chatSettings.streamResponses }" @click="chatSettings.streamResponses = !chatSettings.streamResponses"></div>
      </div>
      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-label">Show Tool Actions</span>
          <span class="toggle-desc">Display agent tool actions in chat</span>
        </div>
        <div class="toggle" :class="{ on: chatSettings.showToolActions }" @click="chatSettings.showToolActions = !chatSettings.showToolActions"></div>
      </div>
      <div class="settings-item">
        <label class="settings-label">Temperature</label>
        <div class="slider-row">
          <input type="range" min="0" max="100" :value="temperatureSlider" @input="onTemperatureInput" />
          <span>{{ temperatureDisplay }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ChatSettings } from '../../../scripts/core/settings';

defineProps<{
  activeSection: string;
  chatSettings: ChatSettings;
  temperatureSlider: number;
  temperatureDisplay: string;
  onTemperatureInput: (event: Event) => void;
}>();
</script>
