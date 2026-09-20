<script setup lang="ts">
import { computed } from 'vue';

interface PartRow {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  category?: string | null;
}

const props = defineProps<{
  parts: PartRow[];
  modelValue: string | null;
  label?: string;
}>();

const emit = defineEmits<{ (e: 'update:modelValue', value: string | null): void }>();

interface Node {
  value: string;
  label: string;
  children?: Node[];
}

/** 部位是树形结构：复发识别要求落到叶子节点（如"右肘"），所以选择器做成级联 */
const tree = computed<Node[]>(() => {
  const byId = new Map<string, Node>();
  for (const part of props.parts) byId.set(part.id, { value: part.id, label: part.name, children: [] });
  const roots: Node[] = [];
  for (const part of props.parts) {
    const node = byId.get(part.id)!;
    if (part.parentId && byId.has(part.parentId)) byId.get(part.parentId)!.children!.push(node);
    else roots.push(node);
  }
  const prune = (nodes: Node[]): Node[] =>
    nodes.map((node) => {
      const children = node.children && node.children.length > 0 ? prune(node.children) : undefined;
      return children ? { ...node, children } : { value: node.value, label: node.label };
    });
  return prune(roots);
});

const selectedPath = computed(() => {
  if (!props.modelValue) return [];
  const path: string[] = [];
  let current = props.parts.find((p) => p.id === props.modelValue);
  while (current) {
    path.unshift(current.id);
    current = current.parentId ? props.parts.find((p) => p.id === current!.parentId) : undefined;
  }
  return path;
});

const selectedName = computed(() => props.parts.find((p) => p.id === props.modelValue)?.name ?? '未选择');
</script>

<template>
  <div>
    <el-cascader
      :model-value="selectedPath"
      :options="tree"
      :props="{ checkStrictly: false, emitPath: true, expandTrigger: 'hover' }"
      :placeholder="label ?? '选择破损部位（要选到最具体的一层）'"
      filterable
      clearable
      style="width: 100%"
      @update:model-value="(value: unknown) => emit('update:modelValue', Array.isArray(value) && value.length ? String(value[value.length - 1]) : null)"
    />
    <div class="field-hint">已选：{{ selectedName }}（部位是复发识别的匹配键，请选到最具体的层级）</div>
  </div>
</template>
