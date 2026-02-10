/**
 * Message router — maps incoming message types to handlers.
 * Do NOT add handler logic here. Create new handler files in this folder.
 */
import type {
    CollapseThinkingMessage,
    InitMessage,
    LoadSessionMessagesMessage,
    ShowToolActionMessage,
    StartProgressGroupMessage,
    StreamChunkMessage,
    StreamThinkingMessage,
    ToolApprovalResultMessage
} from '../types';
import { handleFileEditApprovalResult, handleRequestFileEditApproval, handleRequestToolApproval, handleToolApprovalResult } from './approvals';
import { handleFileChangeResult, handleFilesChanged, handleFilesDiffStats, handleKeepUndoResult, handleReviewChangePosition } from './filesChanged';
import { handleFinishProgressGroup, handleShowError, handleShowToolAction, handleStartProgressGroup } from './progress';
import {
    handleAddContextItem,
    handleAddMessage,
    handleAppendSessions,
    handleBearerTokenSaved,
    handleCapabilityCheckComplete,
    handleCapabilityCheckProgress,
    handleClearMessages,
    handleConnectionError,
    handleConnectionTestResult,
    handleDbMaintenanceResult,
    handleDeletionProgress,
    handleGenerationStarted,
    handleGenerationStopped,
    handleHideThinking,
    handleInit,
    handleLoadSessionMessages,
    handleLoadSessions,
    handleModelEnabledChanged,
    handleNavigateToSettings,
    handleRecreateMessagesResult,
    handleSearchSessionsResult,
    handleSessionApprovalSettings,
    handleSessionDeleted,
    handleSessionsDeleted,
    handleSettingsUpdate,
    handleShowThinking,
    handleShowWarningBanner,
    handleUpdateSessionStatus
} from './sessions';
import { handleCollapseThinking, handleFinalMessage, handleStreamChunk, handleStreamThinking } from './streaming';

export const handleMessage = (msg: any) => {
  switch (msg.type) {
    case 'init':
      handleInit(msg as InitMessage);
      break;
    case 'loadSessions':
      handleLoadSessions(msg);
      break;
    case 'appendSessions':
      handleAppendSessions(msg);
      break;
    case 'updateSessionStatus':
      handleUpdateSessionStatus(msg);
      break;
    case 'loadSessionMessages':
      handleLoadSessionMessages(msg as LoadSessionMessagesMessage);
      break;
    case 'requestToolApproval':
      handleRequestToolApproval(msg);
      break;
    case 'requestFileEditApproval':
      handleRequestFileEditApproval(msg);
      break;
    case 'toolApprovalResult':
      handleToolApprovalResult(msg as ToolApprovalResultMessage);
      break;
    case 'fileEditApprovalResult':
      handleFileEditApprovalResult(msg);
      break;
    case 'sessionApprovalSettings':
      handleSessionApprovalSettings(msg);
      break;
    case 'addMessage':
      handleAddMessage(msg);
      break;
    case 'showThinking':
      handleShowThinking(msg);
      break;
    case 'hideThinking':
      handleHideThinking(msg);
      break;
    case 'startProgressGroup':
      handleStartProgressGroup(msg as StartProgressGroupMessage);
      break;
    case 'showToolAction':
      handleShowToolAction(msg as ShowToolActionMessage);
      break;
    case 'finishProgressGroup':
      handleFinishProgressGroup(msg);
      break;
    case 'streamChunk':
      handleStreamChunk(msg as StreamChunkMessage);
      break;
    case 'finalMessage':
      handleFinalMessage(msg as StreamChunkMessage);
      break;
    case 'streamThinking':
      handleStreamThinking(msg as StreamThinkingMessage);
      break;
    case 'collapseThinking':
      handleCollapseThinking(msg as CollapseThinkingMessage);
      break;
    case 'showWarningBanner':
      handleShowWarningBanner(msg);
      break;
    case 'generationStarted':
      handleGenerationStarted(msg);
      break;
    case 'generationStopped':
      handleGenerationStopped(msg);
      break;
    case 'addContextItem':
      handleAddContextItem(msg);
      break;
    case 'showError':
      handleShowError(msg);
      break;
    case 'clearMessages':
      handleClearMessages(msg);
      break;
    case 'connectionTestResult':
      handleConnectionTestResult(msg);
      break;
    case 'bearerTokenSaved':
      handleBearerTokenSaved();
      break;
    case 'connectionError':
      handleConnectionError(msg);
      break;
    case 'settingsUpdate':
      handleSettingsUpdate(msg);
      break;
    case 'searchSessionsResult':
      handleSearchSessionsResult(msg);
      break;
    case 'dbMaintenanceResult':
      handleDbMaintenanceResult(msg);
      break;
    case 'recreateMessagesResult':
      handleRecreateMessagesResult(msg);
      break;
    case 'sessionDeleted':
      handleSessionDeleted(msg);
      break;
    case 'sessionsDeleted':
      handleSessionsDeleted(msg);
      break;
    case 'deletionProgress':
      handleDeletionProgress(msg);
      break;
    case 'navigateToSettings':
      handleNavigateToSettings(msg);
      break;
    case 'capabilityCheckProgress':
      handleCapabilityCheckProgress(msg);
      break;
    case 'capabilityCheckComplete':
      handleCapabilityCheckComplete();
      break;
    case 'modelEnabledChanged':
      handleModelEnabledChanged(msg);
      break;
    case 'filesChanged':
      handleFilesChanged(msg);
      break;
    case 'filesDiffStats':
      handleFilesDiffStats(msg);
      break;
    case 'fileChangeResult':
      handleFileChangeResult(msg);
      break;
    case 'keepUndoResult':
      handleKeepUndoResult(msg);
      break;
    case 'reviewChangePosition':
      handleReviewChangePosition(msg);
      break;
  }
};
