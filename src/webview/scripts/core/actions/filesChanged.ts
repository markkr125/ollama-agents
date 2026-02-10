import { vscode } from '../state';

export const openFileChangeDiff = (checkpointId: string, filePath: string) => {
  vscode.postMessage({ type: 'openFileChangeDiff', checkpointId, filePath });
};

export const openFileChangeReview = (checkpointId: string, filePath: string) => {
  vscode.postMessage({ type: 'openFileChangeReview', checkpointId, filePath });
};

export const keepFile = (checkpointId: string, filePath: string) => {
  vscode.postMessage({ type: 'keepFile', checkpointId, filePath });
};

export const undoFile = (checkpointId: string, filePath: string) => {
  vscode.postMessage({ type: 'undoFile', checkpointId, filePath });
};

/** Keep all pending changes across ALL checkpoints. */
export const keepAllChanges = (checkpointIds: string[]) => {
  for (const checkpointId of checkpointIds) {
    vscode.postMessage({ type: 'keepAllChanges', checkpointId });
  }
};

/** Undo all pending changes across ALL checkpoints. */
export const undoAllChanges = (checkpointIds: string[]) => {
  for (const checkpointId of checkpointIds) {
    vscode.postMessage({ type: 'undoAllChanges', checkpointId });
  }
};

export const requestFilesDiffStats = (checkpointId: string) => {
  vscode.postMessage({ type: 'requestFilesDiffStats', checkpointId });
};

export const navigatePrevChange = (checkpointIds: string[]) => {
  vscode.postMessage({ type: 'navigateReviewPrev', checkpointIds });
};

export const navigateNextChange = (checkpointIds: string[]) => {
  vscode.postMessage({ type: 'navigateReviewNext', checkpointIds });
};
