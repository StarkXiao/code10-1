<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <div style="text-align: center; padding: 40px 16px; color: #6b7280">
    <div style="font-size: 15px; color: #1f2328; margin-bottom: 6px">{{ title }}</div>
    <div v-if="description" style="font-size: 13px; margin-bottom: 14px">{{ description }}</div>
    <slot />
  </div>
</template>
