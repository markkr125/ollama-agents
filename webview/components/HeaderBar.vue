<template>
  <div class="header">
    <div class="header-left">
      <button class="back-btn" :class="{ visible: currentPage !== 'chat' }" @click="showPage('chat')">←</button>
      <span class="header-title">{{ headerTitle }}</span>
    </div>
    <div class="header-actions">
      <button class="icon-btn" title="New Chat" @click="newChat">➕</button>
      <button class="icon-btn" title="Settings" @click="showPage('settings')">⚙️</button>
      <button class="icon-btn" title="Sessions" @click="toggleSessions">📋</button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  currentPage: 'chat' | 'settings';
  headerTitle: string;
  showPage: (page: 'chat' | 'settings') => void;
  newChat: () => void;
  toggleSessions: () => void;
}>();
</script>
