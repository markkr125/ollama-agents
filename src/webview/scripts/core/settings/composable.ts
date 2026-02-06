import { ref, watch } from 'vue';
import { updateSessionSensitivePatterns } from '../actions/index';
import { isFirstRun, sessionSensitiveFilePatterns } from '../state';
import type { SettingsPageCallbacks } from './types';

export function useSettingsPage(callbacks: SettingsPageCallbacks) {
  const onBearerInput = (event: Event) => {
    const value = (event.target as HTMLInputElement).value;
    callbacks.setBearerToken(value);
  };

  const onTemperatureInput = (event: Event) => {
    const value = Number((event.target as HTMLInputElement).value);
    callbacks.setTemperatureSlider(value);
  };

  const onToolTimeoutInput = (event: Event) => {
    const value = Number((event.target as HTMLInputElement).value);
    callbacks.setToolTimeoutSeconds(value);
  };

  const confirmRecreateMessagesTable = () => {
    // Use backend confirmation since webview sandbox blocks confirm()
    callbacks.recreateMessagesTable();
  };

  // Session-level sensitive file pattern override
  const localSessionPatterns = ref('');

  watch(
    () => sessionSensitiveFilePatterns.value,
    (value) => {
      localSessionPatterns.value = value || '';
    },
    { immediate: true }
  );

  const saveSessionPatterns = () => {
    updateSessionSensitivePatterns(localSessionPatterns.value);
  };

  const dismissWelcome = () => {
    isFirstRun.value = false;
  };

  return {
    onBearerInput,
    onTemperatureInput,
    onToolTimeoutInput,
    confirmRecreateMessagesTable,
    localSessionPatterns,
    saveSessionPatterns,
    dismissWelcome,
  };
}
