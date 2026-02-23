<template>
  <Teleport to="body">
    <div class="dropdown-overlay" @click.self="$emit('close')">
      <div
        ref="menuEl"
        class="dropdown-menu"
        :style="positionStyle"
        @keydown.escape.prevent="$emit('close')"
        @keydown.arrow-down.prevent="focusNext"
        @keydown.arrow-up.prevent="focusPrev"
        @keydown.enter.prevent="selectFocused"
      >
        <template v-for="(item, i) in items" :key="item.id">
          <div v-if="item.separator" class="dropdown-separator"></div>
          <button
            v-else
            :ref="el => setItemRef(i, el as HTMLElement | null)"
            class="dropdown-item"
            :class="{ active: item.id === modelValue, focused: focusedIndex === i }"
            @click="$emit('select', item.id)"
            @mouseenter="focusedIndex = i"
          >
            <span v-if="item.icon" class="codicon" :class="item.icon"></span>
            <span class="dropdown-item-content">
              <span class="dropdown-item-label">{{ item.label }}</span>
              <span v-if="item.description" class="dropdown-item-desc">{{ item.description }}</span>
            </span>
            <span v-if="item.id === modelValue" class="codicon codicon-check dropdown-item-check"></span>
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';

export interface DropdownItem {
  id: string;
  icon?: string;
  label: string;
  description?: string;
  separator?: boolean;
}

const props = defineProps<{
  items: DropdownItem[];
  modelValue?: string;
  anchorRect: { top: number; left: number; bottom: number; width: number };
}>();

defineEmits<{
  (e: 'select', id: string): void;
  (e: 'close'): void;
}>();

const menuEl = ref<HTMLElement | null>(null);
const focusedIndex = ref(-1);
const itemRefs = ref<Map<number, HTMLElement>>(new Map());
const positionStyle = ref<Record<string, string>>({});

const setItemRef = (index: number, el: HTMLElement | null) => {
  if (el) {
    itemRefs.value.set(index, el);
  } else {
    itemRefs.value.delete(index);
  }
};

const focusNext = () => {
  const items = Array.from(itemRefs.value.keys()).sort((a, b) => a - b);
  const current = items.indexOf(focusedIndex.value);
  focusedIndex.value = items[(current + 1) % items.length] ?? -1;
  scrollToFocused();
};

const focusPrev = () => {
  const items = Array.from(itemRefs.value.keys()).sort((a, b) => a - b);
  const current = items.indexOf(focusedIndex.value);
  focusedIndex.value = items[(current - 1 + items.length) % items.length] ?? -1;
  scrollToFocused();
};

const scrollToFocused = () => {
  const el = itemRefs.value.get(focusedIndex.value);
  el?.scrollIntoView({ block: 'nearest' });
};

const selectFocused = () => {
  if (focusedIndex.value >= 0) {
    const el = itemRefs.value.get(focusedIndex.value);
    el?.click();
  }
};

const computePosition = () => {
  const anchor = props.anchorRect;
  if (!menuEl.value || !anchor) return;

  const menuHeight = menuEl.value.offsetHeight;
  const menuWidth = menuEl.value.offsetWidth;
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;

  // Prefer opening above the anchor (toolbar is at the bottom of the view)
  const spaceAbove = anchor.top;
  const spaceBelow = viewportH - anchor.bottom;

  let top: number;
  if (spaceAbove >= menuHeight || spaceAbove > spaceBelow) {
    // Open above
    top = Math.max(4, anchor.top - menuHeight);
  } else {
    // Open below
    top = Math.min(anchor.bottom, viewportH - menuHeight - 4);
  }

  // Align left edge with the anchor, but keep within viewport
  let left = anchor.left;
  if (left + menuWidth > viewportW - 4) {
    left = viewportW - menuWidth - 4;
  }
  left = Math.max(4, left);

  positionStyle.value = {
    top: `${top}px`,
    left: `${left}px`,
  };
};

onMounted(async () => {
  await nextTick();
  computePosition();
  if (menuEl.value) {
    menuEl.value.focus();
  }
});
</script>
