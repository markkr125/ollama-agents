import { ChangePosition, NavigationTarget, ReviewSession } from './reviewTypes';

// =============================================================================
// ReviewNavigator — pure navigation math for the inline review session.
//
// All methods are stateless: they take a ReviewSession (or subset) and return
// computed indices / positions. Side effects (opening editors, scrolling,
// building sessions) are the caller's responsibility.
// =============================================================================

export class ReviewNavigator {
  /**
   * Compute the next/prev file index (wraps around).
   */
  computeFileNavigation(session: ReviewSession, direction: 'prev' | 'next'): number {
    if (session.files.length === 0) return session.currentFileIndex;
    if (direction === 'next') {
      return (session.currentFileIndex + 1) % session.files.length;
    }
    return (session.currentFileIndex - 1 + session.files.length) % session.files.length;
  }

  /**
   * Compute the next/prev hunk index within the current file (wraps around).
   * Returns the current hunkIndex unchanged if there are no hunks.
   */
  computeHunkNavigation(session: ReviewSession, direction: 'prev' | 'next'): number {
    const fileState = session.files[session.currentFileIndex];
    if (!fileState || fileState.hunks.length === 0) return 0;
    if (direction === 'next') {
      return (fileState.currentHunkIndex + 1) % fileState.hunks.length;
    }
    return (fileState.currentHunkIndex - 1 + fileState.hunks.length) % fileState.hunks.length;
  }

  /**
   * Compute the next/prev hunk across all files (cross-file navigation).
   *
   * Returns a NavigationTarget with the fileIndex, hunkIndex, and whether
   * the caller needs to open a new file editor. Returns `null` if the
   * session has no hunks at all.
   */
  computeChangeNavigation(
    session: ReviewSession,
    direction: 'prev' | 'next'
  ): NavigationTarget | null {
    if (session.files.length === 0) return null;

    // Flatten all hunks across files into a single ordered list.
    const flat: { fileIdx: number; hunkIdx: number }[] = [];
    for (let fi = 0; fi < session.files.length; fi++) {
      for (let hi = 0; hi < session.files[fi].hunks.length; hi++) {
        flat.push({ fileIdx: fi, hunkIdx: hi });
      }
    }

    if (flat.length === 0) return null;

    const currentFlat = flat.findIndex(
      e => e.fileIdx === session.currentFileIndex
        && e.hunkIdx === session.files[session.currentFileIndex]?.currentHunkIndex
    );

    let nextFlat: number;
    if (currentFlat < 0) {
      nextFlat = direction === 'next' ? 0 : flat.length - 1;
    } else if (direction === 'next') {
      nextFlat = (currentFlat + 1) % flat.length;
    } else {
      nextFlat = (currentFlat - 1 + flat.length) % flat.length;
    }

    const target = flat[nextFlat];
    return {
      fileIndex: target.fileIdx,
      hunkIndex: target.hunkIdx,
      needsFileOpen: target.fileIdx !== session.currentFileIndex
    };
  }

  /**
   * Get the current position in the global (cross-file) hunk list.
   */
  getChangePosition(session: ReviewSession): ChangePosition {
    let total = 0;
    let current = 0;
    let found = false;

    for (let fi = 0; fi < session.files.length; fi++) {
      const file = session.files[fi];
      for (let hi = 0; hi < file.hunks.length; hi++) {
        total++;
        if (!found && fi === session.currentFileIndex && hi === file.currentHunkIndex) {
          current = total;
          found = true;
        }
      }
    }

    if (!found) current = total > 0 ? 1 : 0;
    const filePath = session.files[session.currentFileIndex]?.filePath;
    return { current, total, filePath };
  }
}
