<template>
  <div class="markdown-body" v-html="rendered"></div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatMarkdown } from '../../../../scripts/core/actions';

const props = defineProps<{
  content: string;
}>();

const rendered = computed(() => formatMarkdown(props.content));
</script>
