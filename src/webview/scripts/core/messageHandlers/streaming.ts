import { scrollToBottom, startAssistantMessage } from '../actions/index';
import { activeThinkingGroup, currentAssistantThreadId, currentSessionId, currentStreamIndex } from '../state';
import type {
  AssistantThreadTextBlock,
  AssistantThreadThinkingBlock,
  AssistantThreadThinkingGroupBlock,
  CollapseThinkingMessage,
  StreamChunkMessage,
  StreamThinkingMessage,
  ThinkingGroupSection
} from '../types';
import { ensureAssistantThread } from './threadUtils';

/**
 * Tracks the text block currently being streamed to.
 * Reset when a new thinking block is created (signaling a new iteration),
 * so the next streamChunk creates a new text block at the current position.
 * This prevents the old getLastTextBlock approach from creating duplicate
 * text blocks and ensures per-iteration text blocks match the DB structure.
 */
let activeStreamBlock: AssistantThreadTextBlock | null = null;

/**
 * Set to true when collapseThinking fires inside a group.
 * Forces the next handleStreamThinking to create a NEW thinkingContent
 * section rather than updating the existing one (the old round is done).
 */
let thinkingRoundCollapsed = false;

/** Reset the active stream block (called on new iteration / generation end). */
export const resetActiveStreamBlock = () => {
  activeStreamBlock = null;
  thinkingRoundCollapsed = false;
};

/**
 * Close the currently-active thinking group, if any.
 *
 * The group only contains thinkingContent + tools sections — text content
 * is always streamed directly to thread-level blocks (never inside the group).
 * So closing is just: stop streaming, optionally collapse, sum durations, null out refs.
 *
 * @param collapse Whether to collapse the `<details>` element. Defaults to `true`.
 *   Pass `false` when finalizing at generation-end so the user can still see and
 *   interact with tool results in the last thinking group.
 */
export const closeActiveThinkingGroup = (collapse = true) => {
  const group = activeThinkingGroup.value;
  if (!group) return;

  group.streaming = false;
  group.collapsed = collapse;
  // Sum duration from all thinkingContent sections
  // Also compute duration for any section that hasn't been collapsed yet
  let total = 0;
  for (const s of group.sections) {
    if (s.type === 'thinkingContent') {
      if (!s.durationSeconds && s.startTime) {
        s.durationSeconds = Math.round((Date.now() - s.startTime) / 1000);
      }
      if (s.durationSeconds) {
        total += s.durationSeconds;
      }
    }
  }
  group.totalDurationSeconds = total || undefined;
  activeThinkingGroup.value = null;
  thinkingRoundCollapsed = false;
};

export const handleStreamChunk = (msg: StreamChunkMessage) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  if (currentStreamIndex.value === null) {
    startAssistantMessage(msg.model);
  }
  const thread = ensureAssistantThread(msg.model);
  currentAssistantThreadId.value = thread.id;

  // Text content signals the end of a thinking+tools cycle.
  // Close the active thinking group so the next streamThinking creates a NEW group.
  // This gives: [group₁: thinking+tools] text₁ [group₂: thinking+tools] text₂
  if (msg.content) {
    closeActiveThinkingGroup();
  }

  // Find or create the stream target block for this iteration.
  // If activeStreamBlock is set and still in the thread, reuse it —
  // UNLESS non-text blocks (tools/thinking/thinkingGroup) were added after it,
  // which means a new iteration has started (critical for non-thinking models
  // that don't have streamThinking to reset the target).
  if (activeStreamBlock && thread.blocks.includes(activeStreamBlock)) {
    const idx = thread.blocks.indexOf(activeStreamBlock);
    const hasNonTextAfter = thread.blocks.slice(idx + 1).some(b => b.type !== 'text');
    if (hasNonTextAfter) {
      activeStreamBlock = null;
    }
  }

  if (!activeStreamBlock || !thread.blocks.includes(activeStreamBlock)) {
    const lastBlock = thread.blocks[thread.blocks.length - 1];
    // When a thinking group is active, each iteration gets its own text block
    // (streamThinking resets activeStreamBlock on each new round).
    // For non-thinking models, reuse the last text block if present.
    if (lastBlock && lastBlock.type === 'text' && !activeThinkingGroup.value) {
      activeStreamBlock = lastBlock as AssistantThreadTextBlock;
    } else {
      const raw: AssistantThreadTextBlock = { type: 'text', content: '' };
      thread.blocks.push(raw);
      // CRITICAL: Re-read from the reactive array to get the Vue Proxy wrapper.
      // `thread.blocks` is reactive — pushed objects are wrapped in a Proxy.
      // If we keep the raw reference, writes to `.content` bypass the Proxy's
      // set trap and Vue never detects the change (no re-render).
      activeStreamBlock = thread.blocks[thread.blocks.length - 1] as AssistantThreadTextBlock;
    }
  }

  activeStreamBlock.content = (msg.content || '').replace(/\[TASK_COMPLETE\]/gi, '').trimEnd();
  if (msg.model) {
    thread.model = msg.model;
  }
  scrollToBottom();
};

export const handleFinalMessage = (msg: StreamChunkMessage) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  if (currentStreamIndex.value === null) {
    startAssistantMessage(msg.model);
  }
  const thread = ensureAssistantThread(msg.model);
  currentAssistantThreadId.value = thread.id;

  // Finalize the active thinking group but keep it OPEN so the user
  // can still see and interact with tool results after generation ends.
  closeActiveThinkingGroup(/* collapse */ false);

  // finalMessage carries ONLY new content (e.g., summary prefix "N files modified").
  // Per-iteration text blocks already exist — append to last text block ONLY if it's
  // the last block in the thread (matching timelineBuilder appendText behavior for parity).
  // If tools/thinking blocks follow the last text, create a new text block.
  const cleaned = (msg.content || '').replace(/\[TASK_COMPLETE\]/gi, '').trim();
  if (cleaned) {
    const lastBlock = thread.blocks[thread.blocks.length - 1];
    if (lastBlock && lastBlock.type === 'text') {
      lastBlock.content = lastBlock.content
        ? `${lastBlock.content}\n\n${cleaned}`
        : cleaned;
    } else {
      thread.blocks.push({ type: 'text', content: cleaned });
    }
  }

  if (msg.model) {
    thread.model = msg.model;
  }
  activeStreamBlock = null;
  currentStreamIndex.value = null;
  currentAssistantThreadId.value = null;
  scrollToBottom();
};

/**
 * Handle streaming thinking tokens (transient — not persisted).
 *
 * For thinking models: creates/updates a ThinkingGroupBlock that groups
 * thinking content and tool calls into a single collapsible unit.
 * Text content is never placed inside the group.
 * When a NEW thinking block is created (= new iteration),
 * resets activeStreamBlock so the next streamChunk creates a fresh text block.
 */
export const handleStreamThinking = (msg: StreamThinkingMessage) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  if (currentStreamIndex.value === null) {
    startAssistantMessage();
  }
  const thread = ensureAssistantThread();
  currentAssistantThreadId.value = thread.id;

  const group = activeThinkingGroup.value;

  if (group) {
    // Active thinking group exists — find or create a thinkingContent section
    const lastSection = group.sections[group.sections.length - 1];
    if (lastSection && lastSection.type === 'thinkingContent' && !thinkingRoundCollapsed) {
      // Update existing thinking section (same thinking round)
      lastSection.content = msg.content || '';
    } else {
      // New thinking round after tools/collapse — push a new thinkingContent section
      thinkingRoundCollapsed = false;
      const section: ThinkingGroupSection = { type: 'thinkingContent', content: msg.content || '', startTime: Date.now() };
      group.sections.push(section);
    }
    // Reset so the next streamChunk creates a new text block for this iteration
    // (each iteration's text content is separate at thread level).
    activeStreamBlock = null;
    group.streaming = true;
  } else {
    // No active group — create a new ThinkingGroupBlock
    activeStreamBlock = null;
    thinkingRoundCollapsed = false;
    const newGroup: AssistantThreadThinkingGroupBlock = {
      type: 'thinkingGroup',
      sections: [{ type: 'thinkingContent', content: msg.content || '', startTime: Date.now() }],
      collapsed: false,
      streaming: true
    };
    thread.blocks.push(newGroup);
    activeThinkingGroup.value = newGroup;
  }
  scrollToBottom();
};

/**
 * Collapse the active thinking content after a thinking round is complete.
 * This does NOT close the entire group — the group stays open for subsequent
 * tool calls and new thinking rounds. Only `finalMessage` or `generationStopped`
 * closes the whole group.
 */
export const handleCollapseThinking = (msg: CollapseThinkingMessage) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }

  const group = activeThinkingGroup.value;
  if (group) {
    // Record duration on the last thinkingContent section inside the group
    for (let i = group.sections.length - 1; i >= 0; i--) {
      const section = group.sections[i];
      if (section.type === 'thinkingContent' && !section.durationSeconds) {
        // Prefer the backend-provided duration (excludes tool_call buffering time).
        // Fall back to client-side wall-clock if not provided.
        if (msg.durationSeconds) {
          section.durationSeconds = msg.durationSeconds;
        } else if (section.startTime) {
          section.durationSeconds = Math.round((Date.now() - section.startTime) / 1000);
        }
        break;
      }
    }
    // The group stays open (streaming = false briefly, then next iteration sets it back)
    // Do NOT collapse the group itself here.
    thinkingRoundCollapsed = true;
    return;
  }

  // Fallback for non-grouped thinking blocks (shouldn't happen but defensive)
  const thread = ensureAssistantThread();
  for (const block of thread.blocks) {
    if (block.type === 'thinking' && !(block as AssistantThreadThinkingBlock).collapsed) {
      const tb = block as AssistantThreadThinkingBlock;
      if (msg.durationSeconds) {
        tb.durationSeconds = msg.durationSeconds;
      } else if (tb.startTime) {
        tb.durationSeconds = Math.round((Date.now() - tb.startTime) / 1000);
      }
      tb.collapsed = true;
    }
  }
};
