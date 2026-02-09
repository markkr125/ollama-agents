import { filesChangedBlocks, vscode } from '../state';
import type { AssistantThreadFilesChangedBlock, FileChangeFileItem } from '../types';

/**
 * Handle 'filesChanged' message from backend — create or update a standalone
 * filesChanged block (NOT inside any assistant thread).
 *
 * This is called both:
 *  - Incrementally during the agent loop (each file write emits the growing list)
 *  - Once at end-of-loop as the final persisted event
 *
 * If a block with the same checkpointId already exists, new files are merged in.
 * If no block exists yet, one is created.
 */
export const handleFilesChanged = (msg: any) => {
  const checkpointId = msg.checkpointId || '';

  // Try to find an existing block for this checkpoint (incremental update)
  let block = checkpointId ? findFilesChangedBlock(checkpointId) : null;

  if (block) {
    // Merge: add any files not already in the block
    let added = false;
    for (const f of msg.files || []) {
      const exists = block.files.some((existing: FileChangeFileItem) => existing.path === f.path);
      if (!exists) {
        block.files.push({
          path: f.path,
          action: f.action || 'modified',
          additions: undefined,
          deletions: undefined,
          status: 'pending' as const
        });
        added = true;
      }
    }
    // Re-request diff stats when new files were added
    if (added && checkpointId) {
      block.statsLoading = true;
      vscode.postMessage({ type: 'requestFilesDiffStats', checkpointId });
    }
    return;
  }

  // No existing block — create a new one
  const newBlock: AssistantThreadFilesChangedBlock = {
    type: 'filesChanged',
    checkpointId,
    files: (msg.files || []).map((f: any) => ({
      path: f.path,
      action: f.action || 'modified',
      additions: undefined,
      deletions: undefined,
      status: 'pending' as const
    })),
    totalAdditions: undefined,
    totalDeletions: undefined,
    status: msg.status || 'pending',
    collapsed: false,
    statsLoading: true
  };

  filesChangedBlocks.value.push(newBlock);

  // Request diff stats from backend
  if (checkpointId) {
    vscode.postMessage({ type: 'requestFilesDiffStats', checkpointId });
  }
};

/**
 * Handle 'filesDiffStats' message — populate diff stats on the matching filesChanged block.
 */
export const handleFilesDiffStats = (msg: any) => {
  const checkpointId = msg.checkpointId;
  if (!checkpointId) return;

  const block = findFilesChangedBlock(checkpointId);
  if (!block) return;

  for (const stat of msg.files || []) {
    const file = block.files.find(f => f.path === stat.path);
    if (file && file.status === 'pending') {
      // Only update stats for pending files — resolved files already have
      // their stats zeroed (undone) or locked (kept).
      file.additions = stat.additions;
      file.deletions = stat.deletions;
    }
  }

  // Recalculate totals from the block's own files (respects resolved zeros)
  recalcBlockTotals(block);
  block.statsLoading = false;
};

/**
 * Handle 'fileChangeResult' — update a single file's status in the filesChanged block.
 */
export const handleFileChangeResult = (msg: any) => {
  const block = findFilesChangedBlock(msg.checkpointId);
  if (!block) return;

  if (msg.success) {
    // Remove the resolved file from the list
    const idx = block.files.findIndex(f => f.path === msg.filePath);
    if (idx >= 0) {
      block.files.splice(idx, 1);
    }

    // If no files left, remove the entire block
    if (block.files.length === 0) {
      removeBlock(block);
      return;
    }

    // Recalculate header totals from remaining files
    recalcBlockTotals(block);
  }
};

/**
 * Handle 'keepUndoResult' — update all files' status in the filesChanged block.
 */
export const handleKeepUndoResult = (msg: any) => {
  const block = findFilesChangedBlock(msg.checkpointId);
  if (!block) return;

  if (msg.success) {
    // Keep All / Undo All resolves every pending file — remove the entire block
    removeBlock(block);
  }
};

// ---------------------------------------------------------------------------
// Helpers (exported for use by timelineBuilder)
// ---------------------------------------------------------------------------

export function findFilesChangedBlock(checkpointId: string): AssistantThreadFilesChangedBlock | null {
  return filesChangedBlocks.value.find(b => b.checkpointId === checkpointId) || null;
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

/** Remove a filesChanged block from the standalone list. */
export function removeBlock(block: AssistantThreadFilesChangedBlock): void {
  const idx = filesChangedBlocks.value.indexOf(block);
  if (idx >= 0) {
    filesChangedBlocks.value.splice(idx, 1);
  }
}
