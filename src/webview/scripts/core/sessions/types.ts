import type { SearchResultGroup, SessionItem } from '../types';

// --- Props interface for SessionsPanel component ---

export interface SessionsPanelProps {
  currentPage: 'chat' | 'settings' | 'sessions';
  currentSessionId: string | null;
  sessions: SessionItem[];
  sessionsInitialLoaded: boolean;
  hasMoreSessions: boolean;
  isLoadingMore: boolean;
  searchQuery: string;
  searchResults: SearchResultGroup[];
  searchHasMore: boolean;
  isSearchRevealing: boolean;
  isSearching: boolean;
  loadSession: (id: string) => void;
  deleteSession: (id: string) => void;
  formatTime: (timestamp: number) => string;
  relativeTime: (timestamp: number) => string;
  handleSearchInput: (query: string) => void;
  clearSearch: () => void;
  loadSessionWithMessage: (sessionId: string, messageId: string) => void;
  loadMoreSessions: () => void;
  revealMoreSearchResults: () => void;
  highlightSnippet: (snippet: string, query: string) => string;
  deletingSessionIds: Set<string>;
  selectionMode: boolean;
  selectedSessionIds: Set<string>;
  deletionProgress: { completed: number; total: number } | null;
  toggleSelectionMode: () => void;
  toggleSessionSelection: (id: string) => void;
  selectAllSessions: () => void;
  deleteSelectedSessions: () => void;
  clearSelection: () => void;
}
