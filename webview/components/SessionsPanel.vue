<template>
  <div class="sessions-panel" :class="{ open: sessionsOpen }">
    <div class="sessions-header">
      <span>Sessions</span>
      <button class="icon-btn" @click="closeSessions">✕</button>
    </div>
    
    <!-- Search input -->
    <div class="sessions-search">
      <input
        type="text"
        class="search-input"
        placeholder="Search conversations..."
        :value="searchQuery"
        @input="onSearchInput"
      />
      <button 
        v-if="searchQuery" 
        class="search-clear" 
        @click="onClearSearch"
      >✕</button>
      <span v-if="isSearching" class="search-spinner">⟳</span>
    </div>

    <!-- Search results -->
    <div v-if="searchResults.length > 0" class="search-results">
      <div 
        class="search-result-group" 
        v-for="group in searchResults" 
        :key="group.session.id"
      >
        <div class="search-result-session">
          <span class="session-title">{{ group.session.title }}</span>
          <span class="session-time">{{ formatTime(group.session.timestamp) }}</span>
        </div>
        <div 
          class="search-result-message"
          v-for="message in group.messages"
          :key="message.id"
          @click="onLoadWithMessage(group.session.id, message.id)"
        >
          <span class="message-role">{{ message.role }}</span>
          <span class="message-snippet" v-html="highlightSnippet(message.snippet, searchQuery)"></span>
        </div>
      </div>
    </div>

    <!-- Regular sessions list (when not searching) -->
    <div v-else class="sessions-list">
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
import type { SearchResultGroup, SessionItem } from '../scripts/core/types';

const props = defineProps({
  sessionsOpen: {
    type: Boolean,
    required: true
  },
  sessions: {
    type: Array as PropType<SessionItem[]>,
    required: true
  },
  searchQuery: {
    type: String,
    default: ''
  },
  searchResults: {
    type: Array as PropType<SearchResultGroup[]>,
    default: () => []
  },
  isSearching: {
    type: Boolean,
    default: false
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
  },
  handleSearchInput: {
    type: Function as PropType<(query: string) => void>,
    required: true
  },
  clearSearch: {
    type: Function as PropType<() => void>,
    required: true
  },
  loadSessionWithMessage: {
    type: Function as PropType<(sessionId: string, messageId: string) => void>,
    required: true
  },
  highlightSnippet: {
    type: Function as PropType<(snippet: string, query: string) => string>,
    required: true
  }
});

const onSearchInput = (e: Event) => {
  const target = e.target as HTMLInputElement;
  props.handleSearchInput(target.value);
};

const onClearSearch = () => {
  props.clearSearch();
};

const onLoadWithMessage = (sessionId: string, messageId: string) => {
  props.loadSessionWithMessage(sessionId, messageId);
};
</script>
