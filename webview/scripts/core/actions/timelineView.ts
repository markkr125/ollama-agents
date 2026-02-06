import type { ActionItem, ProgressItem } from '../types';

export const actionStatusClass = (status: ActionItem['status']) => {
  return {
    running: status === 'running',
    done: status === 'success',
    error: status === 'error',
    pending: status === 'pending'
  };
};

export const toggleProgress = (item: ProgressItem) => {
  item.collapsed = !item.collapsed;
};

export const formatTime = (timestamp: number) => {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export const relativeTime = (timestamp: number): string => {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (seconds < 60) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
};
