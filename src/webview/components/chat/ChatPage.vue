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
                :open="!block.collapsed"
              >
                <summary>
                  <span class="thinking-icon">💭</span>
                  Thought
                </summary>
                <div class="thinking-block-content">
                  <MarkdownBlock :content="block.content" />
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
      :onInputText="onInputText"
      :onModeChange="onModeChange"
      :onModelChange="onModelChange"
      :addContext="addContext"
      :removeContext="removeContext"
      :handleEnter="handleEnter"
      :handleSend="handleSend"
      :setInputEl="setInputEl"
    />
  </div>
</template>

<script setup lang="ts">
import type { ChatPageProps } from '../../scripts/core/chat';
import { useChatPage } from '../../scripts/core/chat';
import { filesChangedBlocks, warningBanner } from '../../scripts/core/state';
import ChatInput from './components/ChatInput.vue';
import CommandApproval from './components/CommandApproval.vue';
import FileEditApproval from './components/FileEditApproval.vue';
import FilesChanged from './components/FilesChanged.vue';
import MarkdownBlock from './components/MarkdownBlock.vue';
import ProgressGroup from './components/ProgressGroup.vue';
import SessionControls from './components/SessionControls.vue';

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
</script>
