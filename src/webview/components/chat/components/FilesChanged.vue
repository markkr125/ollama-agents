<template>
  <div class="files-changed" :class="{ collapsed: block.collapsed }">
    <div class="files-changed-header" @click="toggleCollapse">
      <span class="files-changed-chevron">›</span>
      <span class="files-changed-title">
        {{ block.files.length }} file{{ block.files.length !== 1 ? 's' : '' }} changed
      </span>
      <span v-if="block.statsLoading" class="files-changed-loading"><span class="spinner"></span></span>
      <span v-else-if="block.totalAdditions != null" class="files-changed-stats">
        <span class="stat-add">+{{ block.totalAdditions }}</span>
        <span class="stat-del">-{{ block.totalDeletions }}</span>
      </span>
      <span class="files-changed-actions" @click.stop>
        <button class="fc-btn fc-btn-keep" @click="handleKeepAll" title="Keep all changes">Keep</button>
        <button class="fc-btn fc-btn-undo" @click="handleUndoAll" title="Undo all changes">Undo</button>
      </span>
    </div>

    <div class="files-changed-list">
      <div
        v-for="file in block.files"
        :key="file.path"
        class="files-changed-file"
        @click="handleOpenReview(file.path)"
      >
        <span class="file-ext-badge" :class="fileExtClass(file.path)">{{ fileExt(file.path) }}</span>
        <span class="file-name" :title="file.path">{{ fileName(file.path) }}</span>
        <span class="file-dir" v-if="fileDir(file.path)">{{ fileDir(file.path) }}</span>
        <span v-if="file.additions != null" class="file-stats">
          <span class="stat-add">+{{ file.additions }}</span>
          <span class="stat-del">-{{ file.deletions }}</span>
        </span>
        <span class="file-actions" @click.stop>
          <button class="fc-file-btn" @click="handleKeepFile(file.path)" title="Keep this file">✓</button>
          <button class="fc-file-btn" @click="handleUndoFile(file.path)" title="Undo this file">↩</button>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { keepAllChanges, keepFile, openFileChangeReview, undoAllChanges, undoFile } from '../../../scripts/core/actions';
import type { AssistantThreadFilesChangedBlock } from '../../../scripts/core/types';

const props = defineProps<{
  block: AssistantThreadFilesChangedBlock;
}>();

const toggleCollapse = () => {
  props.block.collapsed = !props.block.collapsed;
};

const fileName = (path: string): string => {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
};

const fileDir = (path: string): string => {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash < 0) return '';
  return path.substring(0, lastSlash);
};

const fileExt = (path: string): string => {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return name.substring(dot + 1).toUpperCase();
};

const extColors: Record<string, string> = {
  TS: 'ext-ts', JS: 'ext-js', VUE: 'ext-vue', PY: 'ext-py',
  JSON: 'ext-json', MD: 'ext-md', CSS: 'ext-css', SCSS: 'ext-css',
  HTML: 'ext-html', YAML: 'ext-yaml', YML: 'ext-yaml',
  SH: 'ext-sh', BASH: 'ext-sh', RS: 'ext-rs', GO: 'ext-go',
  JAVA: 'ext-java', CPP: 'ext-cpp', C: 'ext-cpp', H: 'ext-cpp',
};

const fileExtClass = (path: string): string => {
  const ext = fileExt(path);
  return extColors[ext] || 'ext-default';
};

const handleOpenReview = (filePath: string) => {
  openFileChangeReview(props.block.checkpointId, filePath);
};

const handleKeepFile = (filePath: string) => {
  keepFile(props.block.checkpointId, filePath);
};

const handleUndoFile = (filePath: string) => {
  undoFile(props.block.checkpointId, filePath);
};

const handleKeepAll = () => {
  keepAllChanges(props.block.checkpointId);
};

const handleUndoAll = () => {
  undoAllChanges(props.block.checkpointId);
};
</script>
