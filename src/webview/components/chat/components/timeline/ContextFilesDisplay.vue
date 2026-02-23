<template>
  <div v-if="files.length" class="context-files-display">
    <div class="context-files-list">
      <span
        v-for="(file, i) in visibleFiles"
        :key="file.fileName + i"
        class="context-file-chip"
        :title="fileTitle(file)"
        @click="openFile(file)"
      >
        <span class="file-icon" :style="{ color: iconColor(file) }">{{ iconChar(file) }}</span>
        <span class="context-file-name">{{ displayName(file.fileName) }}</span>
      </span>

      <span
        v-if="hasOverflow"
        class="context-file-chip overflow-toggle"
        title="Show all files"
        @click.stop="overflowOpen = !overflowOpen"
      >
        +{{ overflowCount }}
      </span>
    </div>

    <!-- Overflow dropdown -->
    <div v-if="overflowOpen" class="context-files-overflow" @click.stop>
      <div class="overflow-header">
        <span>All references ({{ files.length }})</span>
        <button class="overflow-close" @click="overflowOpen = false">
          <span class="codicon codicon-close"></span>
        </button>
      </div>
      <div class="overflow-list">
        <span
          v-for="(file, i) in files"
          :key="'ov-' + file.fileName + i"
          class="context-file-chip"
          :title="fileTitle(file)"
          @click="openFile(file)"
        >
          <span class="file-icon" :style="{ color: iconColor(file) }">{{ iconChar(file) }}</span>
          <span class="context-file-name">{{ displayName(file.fileName) }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { fileIconChar, fileIconColor } from '../../../../scripts/core/fileIcons';
import { vscode } from '../../../../scripts/core/state';
import type { ContextFileRef } from '../../../../scripts/core/types';

const MAX_VISIBLE = 10;

const props = defineProps<{
  files: ContextFileRef[];
}>();

const overflowOpen = ref(false);

const hasOverflow = computed(() => props.files.length > MAX_VISIBLE);
const overflowCount = computed(() => props.files.length - MAX_VISIBLE);
const visibleFiles = computed(() =>
  hasOverflow.value ? props.files.slice(0, MAX_VISIBLE) : props.files
);

function iconChar(file: ContextFileRef): string {
  if (file.kind === 'implicit-selection') return '≡';
  return fileIconChar(file.fileName);
}

function iconColor(file: ContextFileRef): string {
  if (file.kind === 'implicit-selection') return 'var(--accent)';
  return fileIconColor(file.fileName);
}

/** Extract basename from a possibly-relative path for display, preserving line range. */
function displayName(name: string): string {
  // Separate optional line range suffix (e.g. "src/file.ts:L1-L10" → "src/file.ts" + ":L1-L10")
  const colonIdx = name.indexOf(':L');
  const pathPart = colonIdx >= 0 ? name.substring(0, colonIdx) : name;
  const rangePart = colonIdx >= 0 ? name.substring(colonIdx) : '';
  const parts = pathPart.split('/');
  return (parts[parts.length - 1] || pathPart) + rangePart;
}

const fileTitle = (file: ContextFileRef) => {
  if (file.lineRange) return `${file.fileName} (${file.lineRange})`;
  if (file.kind === 'implicit-file') return `${file.fileName} (implicit)`;
  if (file.kind === 'implicit-selection') return `${file.fileName} (selection)`;
  return file.fileName;
};

function openFile(file: ContextFileRef) {
  // Parse starting line from lineRange (e.g. "L31-L36" → 31)
  let line: number | undefined;
  if (file.lineRange) {
    const m = file.lineRange.match(/L?(\d+)/);
    if (m) line = parseInt(m[1], 10);
  }
  vscode.postMessage({ type: 'openWorkspaceFile', path: file.fileName, line });
}
</script>
