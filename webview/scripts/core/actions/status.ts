import { dbMaintenanceStatus, recreateMessagesStatus } from '../state';
import type { StatusMessage } from '../types';

export const showStatus = (target: StatusMessage, message: string, success: boolean) => {
  target.message = message;
  target.success = success;
  target.visible = true;
  setTimeout(() => {
    target.visible = false;
  }, 3000);
};

export const showDbMaintenanceStatus = (message: string, success: boolean) => {
  showStatus(dbMaintenanceStatus, message, success);
};

export const showRecreateMessagesStatus = (message: string, success: boolean) => {
  showStatus(recreateMessagesStatus, message, success);
};
