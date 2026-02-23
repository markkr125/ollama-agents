<template>
  <div ref="pillEl" class="pill-picker">
    <button
      class="pill-btn"
      :class="{ open: menuOpen }"
      :title="selectedLabel"
      @click="toggleMenu"
    >
      <span v-if="icon" class="codicon" :class="icon"></span>
      <span class="pill-label">{{ selectedLabel }}</span>
      <span class="codicon codicon-chevron-down pill-chevron"></span>
    </button>
    <DropdownMenu
      v-if="menuOpen"
      :items="items"
      :model-value="modelValue"
      :anchor-rect="anchorRect"
      @select="onSelect"
      @close="menuOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DropdownItem } from './DropdownMenu.vue';
import DropdownMenu from './DropdownMenu.vue';

const props = defineProps<{
  items: DropdownItem[];
  modelValue: string;
  icon?: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const pillEl = ref<HTMLElement | null>(null);
const menuOpen = ref(false);
const anchorRect = ref({ top: 0, left: 0, bottom: 0, width: 0 });

const selectedLabel = computed(() => {
  const item = props.items.find(i => i.id === props.modelValue);
  return item?.label ?? props.placeholder ?? props.modelValue;
});

const selectedIcon = computed(() => {
  const item = props.items.find(i => i.id === props.modelValue);
  return item?.icon;
});

// Expose computed icon so parent can use it if needed
defineExpose({ selectedIcon });

const toggleMenu = () => {
  if (menuOpen.value) {
    menuOpen.value = false;
    return;
  }
  if (pillEl.value) {
    const rect = pillEl.value.getBoundingClientRect();
    anchorRect.value = {
      top: rect.top,
      left: rect.left,
      bottom: rect.bottom,
      width: rect.width
    };
  }
  menuOpen.value = true;
};

const onSelect = (id: string) => {
  emit('update:modelValue', id);
  menuOpen.value = false;
};
</script>
