import type {
    InitMessage,
    LoadSessionMessagesMessage,
    ShowToolActionMessage,
    StartProgressGroupMessage,
    StreamChunkMessage,
    ToolApprovalResultMessage
} from '../types';
import { handleFileEditApprovalResult, handleRequestFileEditApproval, handleRequestToolApproval, handleToolApprovalResult } from './approvals';
import { handleFinishProgressGroup, handleShowError, handleShowToolAction, handleStartProgressGroup } from './progress';
import {
    handleAddContextItem,
    handleAddMessage,
    handleAppendSessions,
    handleBearerTokenSaved,
    handleClearMessages,
    handleConnectionError,
    handleConnectionTestResult,
    handleDbMaintenanceResult,
    handleGenerationStarted,
    handleGenerationStopped,
    handleHideThinking,
    handleInit,
    handleLoadSessionMessages,
    handleLoadSessions,
    handleRecreateMessagesResult,
    handleSearchSessionsResult,
    handleSessionApprovalSettings,
    handleSettingsUpdate,
    handleShowThinking,
    handleUpdateSessionStatus
} from './sessions';
import { handleFinalMessage, handleStreamChunk } from './streaming';

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
  }
};
