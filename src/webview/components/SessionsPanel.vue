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
        <button v-if="searchQuery" class="search-clear" @click="onClearSearch">✕</button>
        <span v-if="isSearching" class="search-spinner">⟳</span>
      </div>

      <!-- Selection mode toolbar -->
      <div v-if="!searchQuery && sessions.length > 0" class="sessions-toolbar">
        <button
          v-if="!selectionMode"
          class="toolbar-btn"
          @click="toggleSelectionMode"
          title="Select sessions"
        >Select</button>
        <template v-else>
          <button class="toolbar-btn" @click="selectAllSessions">All</button>
          <span class="toolbar-count" v-if="selectedCount > 0">{{ selectedCount }} selected</span>
          <button
            class="toolbar-btn toolbar-btn-danger"
            :disabled="selectedCount === 0"
            @click="deleteSelectedSessions"
          >Delete ({{ selectedCount }})</button>
          <button class="toolbar-btn" @click="clearSelection">Cancel</button>
        </template>
      </div>

      <!-- Deletion progress -->
      <div v-if="deletionProgress" class="deletion-progress">
        <div class="deletion-progress-bar">
          <div class="deletion-progress-fill" :style="{ width: deletionProgressPercent + '%' }"></div>
        </div>
        <span class="deletion-progress-text">Deleting {{ deletionProgress.completed }}/{{ deletionProgress.total }}...</span>
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
            <span class="session-time">{{ relativeTime(group.session.timestamp) }}</span>
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

      <!-- Initial loading state -->
      <div v-else-if="!searchQuery && sessions.length === 0 && !sessionsInitialLoaded" class="sessions-empty">
        <div class="sessions-empty-icon">⟳</div>
        <div class="sessions-empty-title">Loading conversations...</div>
      </div>

      <!-- Empty state -->
      <div v-else-if="!searchQuery && sessions.length === 0" class="sessions-empty">
        <div class="sessions-empty-icon">💬</div>
        <div class="sessions-empty-title">No conversations yet</div>
        <div class="sessions-empty-subtitle">Start a new chat to begin</div>
      </div>

      <!-- Regular sessions list (when not searching) -->
      <div v-else-if="!searchQuery" class="sessions-list" ref="sessionsListRef" @scroll="onSessionsScroll">
        <div class="sessions-group" v-for="group in categorizedSessions" :key="group.key">
          <div class="sessions-group-title">{{ group.label }}</div>
          <div
            class="session-item"
            v-for="session in group.items"
            :key="session.id"
            :class="{
              active: session.id === currentSessionId && !selectionMode,
              selected: selectionMode && selectedSessionIds.has(session.id),
              deleting: deletingSessionIds.has(session.id)
            }"
            @click="onSessionClick(session)"
          >
            <input
              v-if="selectionMode"
              type="checkbox"
              class="session-checkbox"
              :checked="selectedSessionIds.has(session.id)"
              @click.stop
              @change="toggleSessionSelection(session.id)"
            />
            <div class="session-details">
              <span class="session-title">{{ session.title }}</span>
              <span class="session-status" :class="`status-${session.status}`">
                <span v-if="session.status === 'generating'" class="status-icon status-spinner" aria-hidden="true">⟳</span>
                <span v-else-if="session.status === 'error'" class="status-icon" aria-hidden="true">✕</span>
                <span v-else-if="session.status === 'idle'" class="status-icon" aria-hidden="true">•</span>
                <span v-else class="status-icon" aria-hidden="true">✓</span>
                <span class="status-text">
                  {{ session.status === 'generating' ? 'Loading...' :
                     session.status === 'error' ? 'Error' :
                     session.status === 'idle' ? 'Idle' : 'Completed' }}
                </span>
              </span>
            </div>
            <span class="session-time">{{ relativeTime(session.timestamp) }}</span>
            <button
              v-if="!selectionMode"
              class="session-delete"
              :disabled="deletingSessionIds.has(session.id)"
              @click.stop="onDeleteSession(session.id)"
              title="Delete conversation"
            >
              <span v-if="deletingSessionIds.has(session.id)" class="delete-spinner">⟳</span>
              <span v-else class="delete-icon">🗑</span>
            </button>
          </div>
        </div>
        <div v-if="isLoadingMore" class="sessions-loading">Loading...</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PropType } from 'vue';
import { computed, ref } from 'vue';
import {
  clearSelection,
  deleteSelectedSessions,
  loadSession,
  loadSessionWithMessage,
  selectAllSessions,
  toggleSelectionMode,
  toggleSessionSelection
} from '../scripts/core/actions/index';
import type { SearchResultGroup, SessionItem } from '../scripts/core/types';

const props = defineProps({
  currentPage: {
    type: String as PropType<'chat' | 'settings' | 'sessions'>,
    required: true
  },
  currentSessionId: {
    type: String as PropType<string | null>,
    default: null
  },
  sessions: {
    type: Array as PropType<SessionItem[]>,
    required: true
  },
  sessionsInitialLoaded: {
    type: Boolean,
    default: false
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
  relativeTime: {
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
  },
  deletingSessionIds: {
    type: Object as PropType<Set<string>>,
    default: () => new Set()
  },
  selectionMode: {
    type: Boolean,
    default: false
  },
  selectedSessionIds: {
    type: Object as PropType<Set<string>>,
    default: () => new Set()
  },
  deletionProgress: {
    type: Object as PropType<{ completed: number; total: number } | null>,
    default: null
  },
  toggleSelectionMode: {
    type: Function as PropType<() => void>,
    default: () => {}
  },
  toggleSessionSelection: {
    type: Function as PropType<(id: string) => void>,
    default: () => {}
  },
  selectAllSessions: {
    type: Function as PropType<() => void>,
    default: () => {}
  },
  deleteSelectedSessions: {
    type: Function as PropType<() => void>,
    default: () => {}
  },
  clearSelection: {
    type: Function as PropType<() => void>,
    default: () => {}
  }
});

const sessionsListRef = ref<HTMLDivElement | null>(null);

const selectedCount = computed(() => props.selectedSessionIds.size);

const deletionProgressPercent = computed(() => {
  if (!props.deletionProgress) return 0;
  return Math.round((props.deletionProgress.completed / props.deletionProgress.total) * 100);
});

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

const onSessionClick = (session: SessionItem) => {
  if (props.selectionMode) {
    toggleSessionSelection(session.id);
  } else {
    loadSession(session.id);
  }
};

const onDeleteSession = (id: string) => {
  if (props.deletingSessionIds.has(id)) return;
  props.deleteSession(id);
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
