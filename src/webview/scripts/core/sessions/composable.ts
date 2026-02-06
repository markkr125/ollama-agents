import { computed, ref } from 'vue';
import {
    loadSession,
    loadSessionWithMessage,
    toggleSessionSelection,
} from '../actions/index';
import type { SessionItem } from '../types';
import type { SessionsPanelProps } from './types';

export function useSessionsPanel(props: SessionsPanelProps) {
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

  return {
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
  };
}
