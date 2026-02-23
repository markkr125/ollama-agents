<template>
  <div class="page" :class="{ active: currentPage === 'chat' }">
    <SessionControls
      v-model:expanded="sessionControlsExpanded"
      :currentMode="currentMode"
      :autoApproveCommands="autoApproveCommands"
      :autoApproveConfirmVisible="autoApproveConfirmVisible"
      :toggleAutoApproveCommands="toggleAutoApproveCommands"
      :confirmAutoApproveCommands="confirmAutoApproveCommands"
      :cancelAutoApproveCommands="cancelAutoApproveCommands"
      :autoApproveSensitiveEdits="autoApproveSensitiveEdits"
      :autoApproveSensitiveEditsConfirmVisible="autoApproveSensitiveEditsConfirmVisible"
      :toggleAutoApproveSensitiveEdits="toggleAutoApproveSensitiveEdits"
      :confirmAutoApproveSensitiveEdits="confirmAutoApproveSensitiveEdits"
      :cancelAutoApproveSensitiveEdits="cancelAutoApproveSensitiveEdits"
      :sessionExplorerModel="sessionExplorerModel"
      :modelOptions="modelOptions"
      :setSessionExplorerModel="setSessionExplorerModelAction"
    />

    <div ref="localMessagesEl" class="messages">
      <div v-if="warningBanner.visible" class="warning-banner">
        <span class="warning-banner-icon">⚠️</span>
        <span class="warning-banner-text">{{ warningBanner.message }}</span>
        <button class="warning-banner-dismiss" title="Dismiss" @click="warningBanner.visible = false">✕</button>
      </div>

      <div v-if="timeline.length === 0" class="empty-state">
        <h3>How can I help you today?</h3>
        <p>Ask me to write code, explain concepts, or help with your project.</p>
      </div>

      <template v-for="(item, index) in timeline" :key="item.id">
        <template v-if="item.type === 'assistantThread'">
          <div
            :id="`message-${item.id}`"
            class="message"
            :class="item.role === 'user' ? 'message-user' : 'message-assistant'"
            :data-message-id="item.id"
          >
            <template v-for="(block, bIndex) in item.blocks" :key="`${item.id}-${bIndex}`">
              <MarkdownBlock v-if="block.type === 'text' && block.content" :content="block.content" />

              <details
                v-else-if="block.type === 'thinking'"
                class="thinking-block"
                :class="{ 'is-streaming': !block.collapsed }"
                :open="!block.collapsed"
              >
                <summary>
                  <span class="thinking-chevron">▼</span>
                  <span v-if="!block.collapsed" class="thinking-spinner"></span>
                  <span v-else class="thinking-check">✓</span>
                  <span class="thinking-title">
                    <template v-if="!block.collapsed">Thinking…</template>
                    <template v-else-if="block.durationSeconds">Thought for {{ block.durationSeconds }}s</template>
                    <template v-else>Thought</template>
                  </span>
                </summary>
                <div class="thinking-block-content progress-actions">
                  <MarkdownBlock :content="block.content" />
                </div>
              </details>

              <!-- Thinking Group: groups thinking content + tool calls into a single collapsible -->
              <details
                v-else-if="block.type === 'thinkingGroup'"
                class="thinking-block thinking-group"
                :class="{ 'is-streaming': block.streaming }"
                :open="!block.collapsed"
              >
                <summary>
                  <span class="thinking-chevron">▼</span>
                  <span v-if="block.streaming" class="thinking-spinner"></span>
                  <span v-else class="thinking-check">✓</span>
                  <span class="thinking-title">
                    <template v-if="block.streaming">Thinking…</template>
                    <template v-else-if="block.totalDurationSeconds">Thought for {{ block.totalDurationSeconds }}s</template>
                    <template v-else>Thought</template>
                  </span>
                </summary>
                <div class="thinking-block-content thinking-group-content">
                  <template v-for="(section, sIndex) in block.sections" :key="`${item.id}-${bIndex}-s${sIndex}`">
                    <div v-if="section.type === 'thinkingContent'" class="thinking-group-thinking">
                      <MarkdownBlock :content="section.content" />
                    </div>
                    <div v-else-if="section.type === 'tools'" class="assistant-tools">
                      <template v-for="toolItem in section.tools" :key="toolItem.id">
                        <template v-if="toolItem.type === 'commandApproval'">
                          <CommandApproval
                            :item="toolItem"
                            :on-approve="handleApproveCommand"
                            :on-skip="handleSkipCommand"
                            :auto-approve-enabled="autoApproveCommands"
                            :on-toggle-auto-approve="toggleAutoApproveCommands"
                          />
                        </template>
                        <template v-else-if="toolItem.type === 'fileEditApproval'">
                          <FileEditApproval
                            :item="toolItem"
                            :on-approve="handleApproveFileEdit"
                            :on-skip="handleSkipFileEdit"
                            :on-open-diff="handleOpenFileDiff"
                            :auto-approve-enabled="autoApproveSensitiveEdits"
                            :on-toggle-auto-approve="toggleAutoApproveSensitiveEdits"
                          />
                        </template>
                        <ProgressGroup
                          v-else-if="toolItem.type === 'progress'"
                          :item="toolItem"
                          :toggleProgress="toggleProgress"
                          :progressStatus="progressStatus"
                          :progressStatusClass="progressStatusClass"
                          :actionStatusClass="actionStatusClass"
                        />
                      </template>
                    </div>
                  </template>
                </div>
              </details>

              <div v-else-if="block.type === 'tools'" class="assistant-tools">
                <template v-for="toolItem in block.tools" :key="toolItem.id">
                  <template v-if="toolItem.type === 'commandApproval'">
                    <CommandApproval
                      :item="toolItem"
                      :on-approve="handleApproveCommand"
                      :on-skip="handleSkipCommand"
                      :auto-approve-enabled="autoApproveCommands"
                      :on-toggle-auto-approve="toggleAutoApproveCommands"
                    />
                  </template>

                  <template v-else-if="toolItem.type === 'fileEditApproval'">
                    <FileEditApproval
                      :item="toolItem"
                      :on-approve="handleApproveFileEdit"
                      :on-skip="handleSkipFileEdit"
                      :on-open-diff="handleOpenFileDiff"
                      :auto-approve-enabled="autoApproveSensitiveEdits"
                      :on-toggle-auto-approve="toggleAutoApproveSensitiveEdits"
                    />
                  </template>

                  <ProgressGroup
                    v-else-if="toolItem.type === 'progress'"
                    :item="toolItem"
                    :toggleProgress="toggleProgress"
                    :progressStatus="progressStatus"
                    :progressStatusClass="progressStatusClass"
                    :actionStatusClass="actionStatusClass"
                  />
                </template>
              </div>
            </template>
            <div v-if="item.model" class="message-model">{{ item.model }}</div>
          </div>
          <div
            v-if="index < timeline.length - 1"
            class="message-divider"
          ></div>
        </template>

        <template v-else-if="item.type === 'message'">
          <div
            :id="`message-${item.id}`"
            class="message"
            :class="item.role === 'user' ? 'message-user' : 'message-assistant'"
            :data-message-id="item.id"
          >
            <MarkdownBlock v-if="item.role === 'assistant'" :content="item.content" />
            <div v-else class="message-text">{{ item.content }}</div>
            <div v-if="item.role === 'assistant' && item.model" class="message-model">{{ item.model }}</div>
          </div>
          <ContextFilesDisplay v-if="item.role === 'user' && item.contextFiles?.length" :files="item.contextFiles" />
          <div
            v-if="item.role === 'assistant' && index < timeline.length - 1"
            class="message-divider"
          ></div>
        </template>

        <template v-else-if="item.type === 'commandApproval'">
          <CommandApproval
            :item="item"
            :on-approve="handleApproveCommand"
            :on-skip="handleSkipCommand"
            :auto-approve-enabled="autoApproveCommands"
            :on-toggle-auto-approve="toggleAutoApproveCommands"
          />
        </template>

        <template v-else-if="item.type === 'fileEditApproval'">
          <FileEditApproval
            :item="item"
            :on-approve="handleApproveFileEdit"
            :on-skip="handleSkipFileEdit"
            :on-open-diff="handleOpenFileDiff"
            :auto-approve-enabled="autoApproveSensitiveEdits"
            :on-toggle-auto-approve="toggleAutoApproveSensitiveEdits"
          />
        </template>

        <ProgressGroup
          v-else
          :item="item"
          :toggleProgress="toggleProgress"
          :progressStatus="progressStatus"
          :progressStatusClass="progressStatusClass"
          :actionStatusClass="actionStatusClass"
        />
      </template>

      <div class="thinking" :class="{ visible: thinking.visible }">
        <div class="spinner"></div>
        <span>{{ thinking.text }}</span>
      </div>

      <!-- Plan handoff button (shown after plan mode creates a plan) -->
      <div v-if="pendingPlanContent && !isGenerating" class="plan-handoff">
        <button class="btn btn-primary plan-handoff-btn" @click="handleImplementPlan">
          <span class="codicon codicon-play"></span>
          Start Implementation
        </button>
      </div>
    </div>

    <div v-if="filesChangedBlocks.length" class="files-changed-pinned">
      <FilesChanged
        v-for="(block, idx) in filesChangedBlocks"
        :key="idx"
        :block="block"
      />
    </div>

    <ChatInput
      :contextList="contextList"
      :inputText="inputText"
      :currentMode="currentMode"
      :currentModel="currentModel"
      :modelOptions="modelOptions"
      :isGenerating="isGenerating"
      :implicitFile="implicitFile"
      :implicitSelection="implicitSelection"
      :implicitFileEnabled="implicitFileEnabled"
      :toolsActive="sessionControlsExpanded"
      :onInputText="onInputText"
      :onModeChange="onModeChange"
      :onModelChange="onModelChange"
      :addContext="addContext"
      :addContextFromFile="addContextFromFile"
      :addContextCurrentFile="addContextCurrentFile"
      :addContextFromTerminal="addContextFromTerminal"
      :removeContext="removeContext"
      :handleEnter="handleEnter"
      :handleSend="handleSend"
      :setInputEl="setInputEl"
      :toggleImplicitFile="toggleImplicitFile"
      :promoteImplicitFile="promoteImplicitFile"
      :pinSelection="pinSelection"
      @toggle-tools="sessionControlsExpanded = !sessionControlsExpanded"
    />
  </div>
</template>

<script setup lang="ts">
import { setSessionExplorerModel } from '../../scripts/core/actions/sessions';
import type { ChatPageProps } from '../../scripts/core/chat';
import { useChatPage } from '../../scripts/core/chat';
import { filesChangedBlocks, implicitFile, implicitFileEnabled, implicitSelection, isGenerating, pendingPlanContent, sessionExplorerModel, vscode, warningBanner } from '../../scripts/core/state';
import FilesChanged from './components/FilesChanged.vue';
import ChatInput from './components/input/ChatInput.vue';
import SessionControls from './components/SessionControls.vue';
import CommandApproval from './components/timeline/CommandApproval.vue';
import ContextFilesDisplay from './components/timeline/ContextFilesDisplay.vue';
import FileEditApproval from './components/timeline/FileEditApproval.vue';
import MarkdownBlock from './components/timeline/MarkdownBlock.vue';
import ProgressGroup from './components/timeline/ProgressGroup.vue';

const props = defineProps<ChatPageProps>();

const {
  localMessagesEl,
  sessionControlsExpanded,
  progressStatus,
  progressStatusClass,
  handleApproveCommand,
  handleSkipCommand,
  handleApproveFileEdit,
  handleSkipFileEdit,
  handleOpenFileDiff,
  onInputText,
  onModeChange,
  onModelChange,
} = useChatPage(props);

const setSessionExplorerModelAction = (model: string) => {
  setSessionExplorerModel(model);
};

const handleImplementPlan = () => {
  const planContent = pendingPlanContent.value;
  if (!planContent) return;
  pendingPlanContent.value = null;
  vscode.postMessage({ type: 'implementPlan', planContent });
};
</script>
