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
