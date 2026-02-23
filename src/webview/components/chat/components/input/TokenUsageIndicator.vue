<template>
  <div v-if="visible" class="token-usage-indicator" :class="levelClass">
    <button
      class="token-ring-btn"
      :title="summaryText"
      @click.stop="expanded = !expanded"
    >
      <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`">
        <!-- Background ring -->
        <circle
          :cx="center" :cy="center" :r="radius"
          fill="none"
          stroke="var(--token-ring-bg)"
          :stroke-width="strokeWidth"
        />
        <!-- Usage arc -->
        <circle
          :cx="center" :cy="center" :r="radius"
          fill="none"
          stroke="var(--token-ring-fg)"
          :stroke-width="strokeWidth"
          :stroke-dasharray="circumference"
          :stroke-dashoffset="dashOffset"
          stroke-linecap="round"
          class="usage-arc"
        />
      </svg>
    </button>

    <!-- Expanded popup -->
    <Teleport to="body">
      <div v-if="expanded" ref="popupEl" class="token-usage-popup" :style="popupStyle">
        <div class="popup-header">
          <span class="popup-title">Context Window</span>
          <button class="popup-close" @click="expanded = false">
            <span class="codicon codicon-close"></span>
          </button>
        </div>

        <!-- Main usage bar -->
        <div class="usage-bar-container">
          <div class="usage-bar">
            <div class="usage-bar-fill" :class="levelClass" :style="{ width: usagePct + '%' }"></div>
          </div>
          <div class="usage-bar-label">
            {{ formatTokens(promptTokens) }} / {{ formatTokens(contextWindow) }} tokens · {{ usagePct }}%
          </div>
        </div>

        <!-- Category breakdown -->
        <div class="category-section">
          <div class="category-group-label">System</div>
          <div class="category-row">
            <span class="category-name">System Instructions</span>
            <span class="category-pct">{{ categoryPct(categories.system) }}%</span>
          </div>
          <div class="category-row">
            <span class="category-name">Tool Definitions</span>
            <span class="category-pct">{{ categoryPct(categories.toolDefinitions) }}%</span>
          </div>
        </div>

        <div class="category-section">
          <div class="category-group-label">User Context</div>
          <div class="category-row">
            <span class="category-name">Messages</span>
            <span class="category-pct">{{ categoryPct(categories.messages) }}%</span>
          </div>
          <div class="category-row">
            <span class="category-name">Tool Results</span>
            <span class="category-pct">{{ categoryPct(categories.toolResults) }}%</span>
          </div>
          <div class="category-row">
            <span class="category-name">Files</span>
            <span class="category-pct">{{ categoryPct(categories.files) }}%</span>
          </div>
        </div>

        <div v-if="usagePct >= 70" class="usage-warning">
          Quality declines as limit nears.
        </div>
      </div>
    </Teleport>

    <!-- Click-away overlay -->
    <Teleport to="body">
      <div v-if="expanded" class="token-usage-backdrop" @click="expanded = false"></div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{
  visible: boolean;
  promptTokens: number;
  completionTokens: number;
  contextWindow: number;
  categories: {
    system: number;
    toolDefinitions: number;
    messages: number;
    toolResults: number;
    files: number;
    total: number;
  };
}>();

const expanded = ref(false);
const popupEl = ref<HTMLElement | null>(null);
const popupStyle = ref<Record<string, string>>({});

// Ring dimensions
const size = 20;
const strokeWidth = 2.5;
const center = size / 2;
const radius = (size - strokeWidth) / 2;
const circumference = 2 * Math.PI * radius;

const usagePct = computed(() => {
  if (!props.contextWindow) return 0;
  return Math.min(100, Math.round((props.promptTokens / props.contextWindow) * 100));
});

const dashOffset = computed(() => {
  const pct = usagePct.value / 100;
  return circumference * (1 - pct);
});

const levelClass = computed(() => {
  const pct = usagePct.value;
  if (pct >= 80) return 'level-danger';
  if (pct >= 50) return 'level-warning';
  return 'level-ok';
});

const summaryText = computed(() =>
  `${formatTokens(props.promptTokens)} / ${formatTokens(props.contextWindow)} tokens (${usagePct.value}%)`
);

function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function categoryPct(value: number): string {
  if (!props.promptTokens) return '0';
  return ((value / props.promptTokens) * 100).toFixed(1).replace(/\.0$/, '');
}

// Position the popup above the ring button
function positionPopup() {
  // Find the ring button via the component's root element
  const root = document.querySelector('.token-usage-indicator');
  const btn = root?.querySelector('.token-ring-btn');
  if (!btn) {
    popupStyle.value = { bottom: '60px', right: '16px' };
    return;
  }
  const rect = btn.getBoundingClientRect();
  const popupHeight = popupEl.value?.offsetHeight || 260;
  const top = rect.top - popupHeight - 8;
  // If popup would go off-screen top, position below instead
  if (top < 4) {
    popupStyle.value = {
      top: `${rect.bottom + 8}px`,
      right: `${window.innerWidth - rect.right}px`
    };
  } else {
    popupStyle.value = {
      top: `${top}px`,
      right: `${window.innerWidth - rect.right}px`
    };
  }
}

// Close on Escape key
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && expanded.value) {
    expanded.value = false;
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
});

watch(expanded, (val) => {
  if (val) {
    // Position after DOM update + render
    nextTick(() => requestAnimationFrame(positionPopup));
  }
});
</script>
