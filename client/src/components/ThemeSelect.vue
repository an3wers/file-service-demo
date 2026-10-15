<script setup lang="ts">
import { MonitorIcon, MoonIcon, SunIcon } from "@lucide/vue";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTheme } from "@/composables/useTheme";

const { mode, setMode } = useTheme();
const options = [
  { value: "light", label: "Светлая", icon: SunIcon },
  { value: "dark", label: "Тёмная", icon: MoonIcon },
  { value: "system", label: "Системная", icon: MonitorIcon },
] as const;

function selectMode(value: unknown): void {
  if (value === "light" || value === "dark" || value === "system") {
    setMode(value);
  }
}
</script>

<template>
  <Select :model-value="mode" @update:model-value="selectMode">
    <SelectTrigger aria-label="Тема оформления" class="w-40 shrink-0">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem
        v-for="option in options"
        :key="option.value"
        :value="option.value"
      >
        <component :is="option.icon" aria-hidden="true" />
        {{ option.label }}
      </SelectItem>
    </SelectContent>
  </Select>
</template>
