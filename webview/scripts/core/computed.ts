import { computed } from 'vue';
import { allSearchResults, currentPage, searchVisibleCount, settings, temperatureSlider } from './state';

export const temperatureDisplay = computed(() => (temperatureSlider.value / 100).toFixed(1));

export const toolTimeoutSeconds = computed({
  get: () => Math.floor(settings.toolTimeout / 1000),
  set: value => {
    settings.toolTimeout = Math.max(1, value) * 1000;
  }
});

export const headerTitle = computed(() => {
  if (currentPage.value === 'settings') return 'Settings';
  if (currentPage.value === 'sessions') return 'Sessions';
  return 'Copilot';
});

export const searchTotalCount = computed(() =>
  allSearchResults.value.reduce((sum, group) => sum + group.messages.length, 0)
);

export const searchHasMore = computed(() => searchVisibleCount.value < searchTotalCount.value);
