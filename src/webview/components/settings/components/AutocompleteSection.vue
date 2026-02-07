<template>
  <div class="settings-section" :class="{ active: activeSection === 'autocomplete' }">
    <div class="settings-group">
      <h3>Autocomplete Settings</h3>
      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-label">Enable Autocomplete</span>
          <span class="toggle-desc">Provide inline code suggestions</span>
        </div>
        <div class="toggle" :class="{ on: settings.enableAutoComplete }" @click="toggleAutocomplete"></div>
      </div>
      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-label">Auto Trigger</span>
          <span class="toggle-desc">Trigger suggestions automatically</span>
        </div>
        <div class="toggle" :class="{ on: autocomplete.autoTrigger }" @click="autocomplete.autoTrigger = !autocomplete.autoTrigger"></div>
      </div>
      <div class="settings-item">
        <label class="settings-label">Trigger Delay (ms)</label>
        <input type="number" v-model.number="autocomplete.triggerDelay" />
      </div>
      <div class="settings-item">
        <label class="settings-label">Max Tokens</label>
        <input type="number" v-model.number="autocomplete.maxTokens" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AutocompleteSettings, Settings } from '../../../scripts/core/settings';

defineProps<{
  activeSection: string;
  settings: Settings;
  autocomplete: AutocompleteSettings;
  toggleAutocomplete: () => void;
}>();
</script>
