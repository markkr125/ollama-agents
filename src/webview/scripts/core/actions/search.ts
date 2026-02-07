import {
    allSearchResults,
    isSearching,
    searchIsRevealing,
    searchQuery,
    searchResults,
    searchVisibleCount,
    vscode
} from '../state';
import type { SearchResultGroup } from '../types';

let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const SEARCH_PAGE_SIZE = 20;

const getSearchTotalCount = (groups: SearchResultGroup[]) =>
  groups.reduce((sum, group) => sum + group.messages.length, 0);

const buildVisibleSearchResults = (groups: SearchResultGroup[], maxMessages: number) => {
  if (maxMessages <= 0) return [];
  const visible: SearchResultGroup[] = [];
  let remaining = maxMessages;

  for (const group of groups) {
    if (remaining <= 0) break;
    const messages = group.messages.slice(0, remaining);
    if (messages.length > 0) {
      visible.push({ session: group.session, messages });
      remaining -= messages.length;
    }
  }

  return visible;
};

const updateVisibleSearchResults = () => {
  searchResults.value = buildVisibleSearchResults(allSearchResults.value, searchVisibleCount.value);
};

const resetSearchState = () => {
  allSearchResults.value = [];
  searchResults.value = [];
  searchVisibleCount.value = SEARCH_PAGE_SIZE;
  searchIsRevealing.value = false;
};

export const applySearchResults = (groups: SearchResultGroup[]) => {
  allSearchResults.value = groups;
  const total = getSearchTotalCount(groups);
  searchVisibleCount.value = Math.min(SEARCH_PAGE_SIZE, total);
  searchIsRevealing.value = false;
  updateVisibleSearchResults();
};

export const revealMoreSearchResults = () => {
  const total = getSearchTotalCount(allSearchResults.value);
  if (searchVisibleCount.value >= total) return;
  searchIsRevealing.value = true;
  searchVisibleCount.value = Math.min(searchVisibleCount.value + SEARCH_PAGE_SIZE, total);
  updateVisibleSearchResults();
  setTimeout(() => {
    searchIsRevealing.value = false;
  }, 150);
};

export const handleSearchInput = (query: string) => {
  searchQuery.value = query;

  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }

  if (!query.trim()) {
    resetSearchState();
    isSearching.value = false;
    return;
  }

  isSearching.value = true;
  resetSearchState();
  searchDebounceTimer = setTimeout(() => {
    vscode.postMessage({ type: 'searchSessions', query: query.trim() });
  }, 300);
};

export const clearSearch = () => {
  searchQuery.value = '';
  resetSearchState();
  isSearching.value = false;
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
};

export const highlightSnippet = (snippet: string, query: string): string => {
  if (!query.trim()) return snippet;

  const words = query.trim().split(/\s+/).filter(w => w.length > 2);
  let result = snippet;

  for (const word of words) {
    const regex = new RegExp(`(${word})`, 'gi');
    result = result.replace(regex, '<mark>$1</mark>');
  }

  return result;
};
