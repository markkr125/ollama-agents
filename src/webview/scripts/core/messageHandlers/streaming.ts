import { scrollToBottom, startAssistantMessage } from '../actions/index';
import { currentAssistantThreadId, currentSessionId, currentStreamIndex } from '../state';
import type { AssistantThreadTextBlock, AssistantThreadThinkingBlock, CollapseThinkingMessage, StreamChunkMessage, StreamThinkingMessage } from '../types';
import { ensureAssistantThread } from './threadUtils';

/**
 * Tracks the text block currently being streamed to.
 * Reset when a new thinking block is created (signaling a new iteration),
 * so the next streamChunk creates a new text block at the current position.
 * This prevents the old getLastTextBlock approach from creating duplicate
 * text blocks and ensures per-iteration text blocks match the DB structure.
 */
let activeStreamBlock: AssistantThreadTextBlock | null = null;

/** Reset the active stream block (called on new iteration / generation end). */
export const resetActiveStreamBlock = () => {
  activeStreamBlock = null;
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

  // Find or create the stream target block for this iteration.
  // If activeStreamBlock is set and still in the thread, reuse it —
  // UNLESS non-text blocks (tools/thinking) were added after it,
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
    if (lastBlock && lastBlock.type === 'text') {
      activeStreamBlock = lastBlock as AssistantThreadTextBlock;
    } else {
      activeStreamBlock = { type: 'text', content: '' };
      thread.blocks.push(activeStreamBlock);
    }
  }

  activeStreamBlock.content = msg.content || '';
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

  // finalMessage carries ONLY new content (e.g., summary prefix "N files modified").
  // Per-iteration text blocks already exist — append to last text block ONLY if it's
  // the last block in the thread (matching timelineBuilder appendText behavior for parity).
  // If tools/thinking blocks follow the last text, create a new text block.
  if (msg.content) {
    const lastBlock = thread.blocks[thread.blocks.length - 1];
    if (lastBlock && lastBlock.type === 'text') {
      lastBlock.content = lastBlock.content
        ? `${lastBlock.content}\n\n${msg.content}`
        : msg.content;
    } else {
      thread.blocks.push({ type: 'text', content: msg.content });
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
 * Creates/updates a ThinkingBlock in the current assistant thread.
 * When a NEW thinking block is created (= new iteration), resets activeStreamBlock
 * so the next streamChunk creates a fresh text block at the correct position.
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

  // Find existing uncollapsed thinking block, or create one
  let thinkingBlock = thread.blocks.find(
    b => b.type === 'thinking' && !(b as AssistantThreadThinkingBlock).collapsed
  ) as AssistantThreadThinkingBlock | undefined;

  if (!thinkingBlock) {
    // NEW thinking block = new iteration → reset stream target so next
    // streamChunk creates a per-iteration text block at the right position
    activeStreamBlock = null;
    thinkingBlock = { type: 'thinking', content: '', collapsed: false, startTime: Date.now() };
    thread.blocks.push(thinkingBlock);
  }

  thinkingBlock.content = msg.content || '';
  scrollToBottom();
};

/**
 * Collapse the active thinking block after thinking is complete.
 */
export const handleCollapseThinking = (msg: CollapseThinkingMessage) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  const thread = ensureAssistantThread();
  for (const block of thread.blocks) {
    if (block.type === 'thinking' && !(block as AssistantThreadThinkingBlock).collapsed) {
      const tb = block as AssistantThreadThinkingBlock;
      if (tb.startTime) {
        tb.durationSeconds = Math.round((Date.now() - tb.startTime) / 1000);
      }
      tb.collapsed = true;
    }
  }
};
