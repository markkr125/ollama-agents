import { handleMessage } from '../core/messageHandlers/index';

export * from '../core/actions/index';
export * from '../core/computed';
export * from '../core/state';

window.addEventListener('message', e => {
  handleMessage(e.data);
});
