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
        <button class="fc-btn fc-btn-keep" title="Keep all changes" @click="handleKeepAll">Keep All</button>
        <button class="fc-btn fc-btn-undo" title="Undo all changes" @click="handleUndoAll">Undo All</button>
      </span>
    </div>

    <div class="files-changed-list">
      <div
        v-for="file in block.files"
        :key="file.path"
        class="files-changed-file"
        :class="{ 'files-changed-file--active': block.activeFilePath === file.path }"
        @click="handleOpenReview(file.path, file.checkpointId)"
      >
        <span class="file-ext-badge" :class="fileExtClass(file.path)">{{ fileExt(file.path) }}</span>
        <span class="file-identity" :title="file.path">
          <span class="file-name">{{ fileName(file.path) }}</span>
          <span v-if="fileDir(file.path)" class="file-dir">{{ fileDir(file.path) }}</span>
        </span>
        <span v-if="file.additions != null" class="file-stats">
          <span class="stat-add">+{{ file.additions }}</span>
          <span class="stat-del">-{{ file.deletions }}</span>
        </span>
        <span class="file-actions" @click.stop>
          <button class="fc-file-btn" title="Keep this file" @click="handleKeepFile(file.path, file.checkpointId)">✓</button>
          <button class="fc-file-btn" title="Undo this file" @click="handleUndoFile(file.path, file.checkpointId)">↩</button>
        </span>
      </div>
    </div>

    <div v-if="block.totalChanges && block.totalChanges > 1" class="files-changed-nav" @click.stop>
      <span class="fc-nav-label">Change {{ block.currentChange ?? 0 }} of {{ block.totalChanges }}</span>
      <button class="fc-nav-arrow-btn" title="Previous change" @click="handleNavPrev">←</button>
      <button class="fc-nav-arrow-btn" title="Next change" @click="handleNavNext">→</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { keepAllChanges, keepFile, navigateNextChange, navigatePrevChange, openFileChangeReview, undoAllChanges, undoFile } from '../../../scripts/core/actions';
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

const handleOpenReview = (filePath: string, checkpointId: string) => {
  openFileChangeReview(checkpointId, filePath);
};

const handleKeepFile = (filePath: string, checkpointId: string) => {
  keepFile(checkpointId, filePath);
};

const handleUndoFile = (filePath: string, checkpointId: string) => {
  undoFile(checkpointId, filePath);
};

const handleKeepAll = () => {
  keepAllChanges(props.block.checkpointIds);
};

const handleUndoAll = () => {
  undoAllChanges(props.block.checkpointIds);
};

const handleNavPrev = () => {
  if (props.block.checkpointIds.length) navigatePrevChange([...props.block.checkpointIds]);
};

const handleNavNext = () => {
  if (props.block.checkpointIds.length) navigateNextChange([...props.block.checkpointIds]);
};
</script>
