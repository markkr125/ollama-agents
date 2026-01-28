<template>
  <div class="sessions-panel" :class="{ open: sessionsOpen }">
    <div class="sessions-header">
      <span>Sessions</span>
      <button class="icon-btn" @click="closeSessions">✕</button>
    </div>
    <div class="sessions-list">
      <div
        class="session-item"
        v-for="session in sessions"
        :key="session.id"
        :class="{ active: session.active }"
        @click="loadSession(session.id)"
      >
        <span class="session-title">{{ session.title }}</span>
        <span class="session-time">{{ formatTime(session.timestamp) }}</span>
        <span class="session-delete" @click.stop="deleteSession(session.id)">✕</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PropType } from 'vue';

type SessionItem = {
  id: string;
  title: string;
  timestamp: number;
  active: boolean;
};

defineProps({
  sessionsOpen: {
    type: Boolean,
    required: true
  },
  sessions: {
    type: Array as PropType<SessionItem[]>,
    required: true
  },
  loadSession: {
    type: Function as PropType<(id: string) => void>,
    required: true
  },
  deleteSession: {
    type: Function as PropType<(id: string) => void>,
    required: true
  },
  formatTime: {
    type: Function as PropType<(timestamp: number) => string>,
    required: true
  },
  closeSessions: {
    type: Function as PropType<() => void>,
    required: true
  }
});
</script>
