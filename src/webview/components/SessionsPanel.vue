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
                <span v-if="session.pendingFileCount && ((session.pendingAdditions ?? 0) > 0 || (session.pendingDeletions ?? 0) > 0)" class="session-pending-badge" :title="`${session.pendingFileCount} file(s) with pending changes`">
                  <span class="pending-additions">+{{ session.pendingAdditions }}</span>
                  <span class="pending-deletions">-{{ session.pendingDeletions }}</span>
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
import type { SessionsPanelProps } from '../scripts/core/sessions';
import { useSessionsPanel } from '../scripts/core/sessions';

const props = defineProps<SessionsPanelProps>();

const {
  sessionsListRef,
  selectedCount,
  deletionProgressPercent,
  categorizedSessions,
  onSearchInput,
  onClearSearch,
  onLoadWithMessage,
  onLoadSession,
  onSessionClick,
  onDeleteSession,
  onSessionsScroll,
  onSearchResultsScroll,
} = useSessionsPanel(props);
</script>
