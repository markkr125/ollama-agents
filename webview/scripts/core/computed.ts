import { computed } from 'vue';
import { currentPage, settings, temperatureSlider } from './state';

export const temperatureDisplay = computed(() => (temperatureSlider.value / 100).toFixed(1));

export const toolTimeoutSeconds = computed({
  get: () => Math.floor(settings.toolTimeout / 1000),
  set: value => {
    settings.toolTimeout = Math.max(1, value) * 1000;
  }
});

export const headerTitle = computed(() => (currentPage.value === 'settings' ? 'Settings' : 'Copilot'));
