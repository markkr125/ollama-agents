<template>
  <div class="page" :class="{ active: currentPage === 'sessions' }">
    <div class="sessions-page">
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
      <div v-if="searchResults.length > 0" class="search-results" @scroll="onSearchResultsScroll">
      <div 
        class="search-result-group" 
        v-for="group in searchResults" 
        :key="group.session.id"
      >
        <div class="search-result-session" @click="onLoadSession(group.session.id)">
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
      <div v-if="isSearchRevealing" class="search-loading">Loading more...</div>
      </div>

    <!-- Regular sessions list (when not searching) -->
      <div v-else class="sessions-list" ref="sessionsListRef" @scroll="onSessionsScroll">
      <div class="session-patterns">
        <div class="session-patterns-header">
          <span class="session-patterns-title">Sensitive edit patterns (session override)</span>
          <button class="btn btn-secondary" @click="onSaveSessionPatterns">Save</button>
        </div>
        <textarea
          class="settings-textarea"
          rows="6"
          v-model="localSessionPatterns"
          spellcheck="false"
          placeholder='{"**/*": true, "**/.env*": false}'
        ></textarea>
        <div class="settings-desc">
          Session patterns override global settings for this session.
        </div>
      </div>
      <div class="sessions-group" v-for="group in categorizedSessions" :key="group.key">
        <div class="sessions-group-title">{{ group.label }}</div>
        <div
          class="session-item"
          v-for="session in group.items"
          :key="session.id"
          :class="{ active: session.active }"
          @click="onLoadSession(session.id)"
        >
          <div class="session-details">
            <span class="session-title">{{ session.title }}</span>
            <span class="session-status" :class="`status-${session.status}`">
              <span
                v-if="session.status === 'generating'"
                class="status-icon status-spinner"
                aria-hidden="true"
              >⟳</span>
              <span
                v-else-if="session.status === 'error'"
                class="status-icon"
                aria-hidden="true"
              >✕</span>
              <span
                v-else-if="session.status === 'idle'"
                class="status-icon"
                aria-hidden="true"
              >•</span>
              <span
                v-else
                class="status-icon"
                aria-hidden="true"
              >✓</span>
              <span class="status-text">
                {{ session.status === 'generating'
                  ? 'Loading...'
                  : session.status === 'error'
                    ? 'Error'
                    : session.status === 'idle'
                      ? 'Idle'
                      : 'Completed' }}
              </span>
            </span>
          </div>
          <span class="session-time">{{ formatTime(session.timestamp) }}</span>
          <span class="session-delete" @click.stop="deleteSession(session.id)">✕</span>
        </div>
      </div>
      <div v-if="isLoadingMore" class="sessions-loading">Loading...</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PropType } from 'vue';
import { computed, ref, watch } from 'vue';
import { loadSession, loadSessionWithMessage, updateSessionSensitivePatterns } from '../scripts/core/actions/index';
import { sessionSensitiveFilePatterns } from '../scripts/core/state';
import type { SearchResultGroup, SessionItem } from '../scripts/core/types';

const props = defineProps({
  currentPage: {
    type: String as PropType<'chat' | 'settings' | 'sessions'>,
    required: true
  },
  sessions: {
    type: Array as PropType<SessionItem[]>,
    required: true
  },
  hasMoreSessions: {
    type: Boolean,
    default: false
  },
  isLoadingMore: {
    type: Boolean,
    default: false
  },
  searchQuery: {
    type: String,
    default: ''
  },
  searchResults: {
    type: Array as PropType<SearchResultGroup[]>,
    default: () => []
  },
  searchHasMore: {
    type: Boolean,
    default: false
  },
  isSearchRevealing: {
    type: Boolean,
    default: false
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
  loadMoreSessions: {
    type: Function as PropType<() => void>,
    required: true
  },
  revealMoreSearchResults: {
    type: Function as PropType<() => void>,
    required: true
  },
  highlightSnippet: {
    type: Function as PropType<(snippet: string, query: string) => string>,
    required: true
  }
});

const sessionsListRef = ref<HTMLDivElement | null>(null);
const localSessionPatterns = ref('');

const onSaveSessionPatterns = () => {
  updateSessionSensitivePatterns(localSessionPatterns.value);
};

watch(
  () => sessionSensitiveFilePatterns.value,
  (value) => {
    localSessionPatterns.value = value || '';
  },
  { immediate: true }
);

const categorizedSessions = computed(() => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const lastWeekStart = todayStart - 7 * 24 * 60 * 60 * 1000;

  const groups = [
    { key: 'today', label: 'Today', items: [] as SessionItem[] },
    { key: 'yesterday', label: 'Yesterday', items: [] as SessionItem[] },
    { key: 'last-week', label: 'Last Week', items: [] as SessionItem[] },
    { key: 'older', label: 'Older', items: [] as SessionItem[] }
  ];

  for (const session of props.sessions) {
    const ts = session.timestamp;
    if (ts >= todayStart) {
      groups[0].items.push(session);
    } else if (ts >= yesterdayStart && ts < todayStart) {
      groups[1].items.push(session);
    } else if (ts >= lastWeekStart && ts < yesterdayStart) {
      groups[2].items.push(session);
    } else {
      groups[3].items.push(session);
    }
  }

  return groups.filter(group => group.items.length > 0);
});

const onSearchInput = (e: Event) => {
  const target = e.target as HTMLInputElement;
  props.handleSearchInput(target.value);
};

const onClearSearch = () => {
  props.clearSearch();
};

const onLoadWithMessage = (sessionId: string, messageId: string) => {
  loadSessionWithMessage(sessionId, messageId);
};

const onLoadSession = (sessionId: string) => {
  loadSession(sessionId);
};

const onSessionsScroll = (event: Event) => {
  if (props.searchQuery || props.searchResults.length > 0) return;
  if (!props.hasMoreSessions || props.isLoadingMore) return;
  const target = event.target as HTMLElement;
  if (!target) return;
  const threshold = 40;
  if (target.scrollTop + target.clientHeight >= target.scrollHeight - threshold) {
    props.loadMoreSessions();
  }
};

const onSearchResultsScroll = (event: Event) => {
  if (!props.searchHasMore || props.isSearchRevealing) return;
  const target = event.target as HTMLElement;
  if (!target) return;
  const threshold = Math.max(40, target.clientHeight * 0.5);
  if (target.scrollTop + target.clientHeight >= target.scrollHeight - threshold) {
    props.revealMoreSearchResults();
  }
};
</script>
