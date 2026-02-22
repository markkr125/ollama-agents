import { triggerRef } from 'vue';
import { filesChangedBlocks, vscode } from '../state';
import type { AssistantThreadFilesChangedBlock, FileChangeFileItem } from '../types';

/**
 * Handle 'filesChanged' message from backend.
 *
 * There is only ever ONE filesChanged block. If one already exists, new files
 * from a different checkpoint are merged into it. If none exists, one is created.
 */
export const handleFilesChanged = (msg: any) => {
  const checkpointId = msg.checkpointId || '';
  const block = getOrCreateBlock();

  // Track this checkpoint if new
  if (checkpointId && !block.checkpointIds.includes(checkpointId)) {
    block.checkpointIds.push(checkpointId);
  }

  // Merge files: add any not already in the block (by path)
  let added = false;
  const incomingPaths = new Set((msg.files || []).map((f: any) => f.path));
  for (const f of msg.files || []) {
    const exists = block.files.some((existing: FileChangeFileItem) => existing.path === f.path);
    if (!exists) {
      block.files.push({
        path: f.path,
        action: f.action || 'modified',
        additions: undefined,
        deletions: undefined,
        status: 'pending' as const,
        checkpointId
      });
      added = true;
    }
  }

  // Detect re-edits: if any incoming file already existed with stats populated,
  // the agent re-edited it — stats are stale and need refreshing.
  const hasReEditedFiles = !added && incomingPaths.size > 0;

  // Request diff stats for this checkpoint — on new files OR re-edits
  if ((added || hasReEditedFiles) && checkpointId) {
    block.statsLoading = true;
    vscode.postMessage({ type: 'requestFilesDiffStats', checkpointId });
  }

  // Safety net: request stats for any older checkpoints whose files are missing stats
  // (e.g. after webview recreation where session restore missed re-fetching)
  if (added) {
    const alreadyRequested = new Set<string>();
    if (checkpointId) alreadyRequested.add(checkpointId);
    for (const f of block.files) {
      if (f.additions === undefined && f.checkpointId && !alreadyRequested.has(f.checkpointId)) {
        alreadyRequested.add(f.checkpointId);
        vscode.postMessage({ type: 'requestFilesDiffStats', checkpointId: f.checkpointId });
      }
    }
  }
};

/**
 * Handle 'filesDiffStats' message — populate diff stats on files from this checkpoint.
 */
export const handleFilesDiffStats = (msg: any) => {
  const checkpointId = msg.checkpointId;
  if (!checkpointId) return;

  const block = getTheBlock();
  if (!block) return;

  for (const stat of msg.files || []) {
    const file = block.files.find(f => f.path === stat.path && f.checkpointId === checkpointId);
    if (file && file.status === 'pending') {
      file.additions = stat.additions;
      file.deletions = stat.deletions;
    }
  }

  recalcBlockTotals(block);
  block.statsLoading = false;
  triggerRef(filesChangedBlocks);
};

/**
 * Handle 'fileChangeResult' — safety net for removing a resolved file.
 *
 * In the normal flow the file is already removed optimistically by the
 * component click handler (FilesChanged.vue → removeFileOptimistic).
 * This handler acts as a fallback for edge cases (e.g. session restore).
 */
export const handleFileChangeResult = (msg: any) => {
  const block = getTheBlock();
  if (!block) return;

  const idx = block.files.findIndex(f => f.path === msg.filePath && f.checkpointId === msg.checkpointId);
  if (idx < 0) return; // Already removed by optimistic update

  if (msg.success) {
    block.files.splice(idx, 1);
  } else {
    block.files[idx] = { ...block.files[idx], status: msg.action === 'kept' ? 'kept' : 'undone' } as FileChangeFileItem;
  }

  // Clean up checkpointIds
  if (!block.files.some(f => f.checkpointId === msg.checkpointId)) {
    const cidx = block.checkpointIds.indexOf(msg.checkpointId);
    if (cidx >= 0) block.checkpointIds.splice(cidx, 1);
  }

  if (block.files.length === 0) {
    filesChangedBlocks.value = [];
    return;
  }

  recalcBlockTotals(block);
  triggerRef(filesChangedBlocks);
};

/**
 * Handle 'keepUndoResult' — remove all files for the given checkpoint.
 */
export const handleKeepUndoResult = (msg: any) => {
  const block = getTheBlock();
  if (!block) return;

  if (msg.success) {
    block.files = block.files.filter(f => f.checkpointId !== msg.checkpointId);
    const cidx = block.checkpointIds.indexOf(msg.checkpointId);
    if (cidx >= 0) block.checkpointIds.splice(cidx, 1);

    if (block.files.length === 0) {
      filesChangedBlocks.value = [];
    } else {
      recalcBlockTotals(block);
      triggerRef(filesChangedBlocks);
    }
  }
};

// ---------------------------------------------------------------------------
// Helpers (exported for use by timelineBuilder and tests)
// ---------------------------------------------------------------------------

/** Get the single filesChanged block, or null. */
export function getTheBlock(): AssistantThreadFilesChangedBlock | null {
  return filesChangedBlocks.value.length > 0 ? filesChangedBlocks.value[0] : null;
}

/** Find the block that contains files for a given checkpointId. */
export function findFilesChangedBlock(checkpointId: string): AssistantThreadFilesChangedBlock | null {
  const block = getTheBlock();
  return block && block.checkpointIds.includes(checkpointId) ? block : null;
}

/** Get or create the ONE block. */
function getOrCreateBlock(): AssistantThreadFilesChangedBlock {
  if (filesChangedBlocks.value.length > 0) {
    return filesChangedBlocks.value[0];
  }
  const block: AssistantThreadFilesChangedBlock = {
    type: 'filesChanged',
    checkpointIds: [],
    files: [],
    totalAdditions: undefined,
    totalDeletions: undefined,
    status: 'pending',
    collapsed: false,
    statsLoading: false
  };
  filesChangedBlocks.value.push(block);
  return block;
}

export function recalcBlockTotals(block: AssistantThreadFilesChangedBlock): void {
  let totalAdd = 0;
  let totalDel = 0;
  for (const f of block.files) {
    totalAdd += f.additions ?? 0;
    totalDel += f.deletions ?? 0;
  }
  block.totalAdditions = totalAdd;
  block.totalDeletions = totalDel;
}

export function updateBlockStatus(block: AssistantThreadFilesChangedBlock): void {
  const statuses = new Set(block.files.map(f => f.status));
  if (statuses.size === 1) {
    const only = [...statuses][0];
    block.status = only === 'kept' ? 'kept' : only === 'undone' ? 'undone' : 'pending';
  } else if (statuses.has('pending')) {
    block.status = 'partial';
  } else {
    block.status = 'partial';
  }
}

/** Remove the ONE block. */
export function removeBlock(): void {
  filesChangedBlocks.value = [];
}

/** Remove a checkpointId from the block if no files reference it. */
function _cleanupCheckpointId(block: AssistantThreadFilesChangedBlock, checkpointId: string): void {
  if (!block.files.some(f => f.checkpointId === checkpointId)) {
    block.checkpointIds = block.checkpointIds.filter(id => id !== checkpointId);
  }
}

/**
 * Handle 'reviewChangePosition' message — update the nav counter.
 */
export const handleReviewChangePosition = (msg: any) => {
  const block = getTheBlock();
  if (!block) return;
  block.currentChange = msg.current;
  block.totalChanges = msg.total;
  if (msg.filePath) block.activeFilePath = msg.filePath;
};
