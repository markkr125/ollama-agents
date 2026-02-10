import * as vscode from 'vscode';

// =============================================================================
// Shared type definitions for the inline review subsystem.
//
// These types are consumed by PendingEditReviewService (facade),
// ReviewSessionBuilder, ReviewNavigator, ReviewDecorationManager,
// ReviewActionHandler logic, and the ReviewCodeLensProvider.
// =============================================================================

/**
 * A single contiguous hunk of changes in a file.
 */
export interface ReviewHunk {
  /** 0-based start line of the hunk in the NEW (current) file */
  startLine: number;
  /** 0-based end line (inclusive) of added lines — same as startLine when pure deletion */
  endLine: number;
  /** 0-based line numbers of added lines in the current file */
  addedLines: number[];
  /** How many lines were deleted from the original */
  deletedCount: number;
  /** The original text that was replaced (for undo) — empty string for pure additions */
  originalText: string;
  /** The new text that replaced it — empty string for pure deletions */
  newText: string;
}

/**
 * Per-file review state.
 */
export interface FileReviewState {
  uri: vscode.Uri;
  checkpointId: string;
  filePath: string;          // relative path
  hunks: ReviewHunk[];
  addedDecoration: vscode.TextEditorDecorationType;
  deletedDecoration: vscode.TextEditorDecorationType;
  /** Index of the hunk currently focused */
  currentHunkIndex: number;
}

/**
 * Tracks the full review session (files across one or more checkpoints).
 */
export interface ReviewSession {
  checkpointIds: string[];
  files: FileReviewState[];
  currentFileIndex: number;
}

/**
 * Emitted when a file has all its hunks resolved during inline review.
 */
export interface FileReviewResolvedEvent {
  checkpointId: string;
  filePath: string;
  /** 'kept' = file still differs from original, 'undone' = file matches original */
  action: 'kept' | 'undone';
}

/**
 * Emitted when a hunk is kept/undone so the widget can update per-file stats.
 */
export interface FileHunkStatsEvent {
  checkpointId: string;
  filePath: string;
  additions: number;
  deletions: number;
}

/**
 * Navigation result returned by ReviewNavigator.computeChangeNavigation().
 */
export interface NavigationTarget {
  fileIndex: number;
  hunkIndex: number;
  needsFileOpen: boolean;
}

/**
 * Position info for the change-navigation bar UI.
 */
export interface ChangePosition {
  current: number;
  total: number;
  filePath?: string;
}
