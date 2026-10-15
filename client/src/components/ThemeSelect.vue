<script setup lang="ts">
import { computed } from "vue";
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
const selectedOption = computed(
  () => options.find((option) => option.value === mode.value) ?? options[2],
);

function selectMode(value: unknown): void {
  if (value === "light" || value === "dark" || value === "system") {
    setMode(value);
  }
}
</script>

<template>
  <Select :model-value="mode" @update:model-value="selectMode">
    <SelectTrigger aria-label="Тема оформления" class="w-fit shrink-0">
      <SelectValue>
        <component
          :is="selectedOption.icon"
          aria-hidden="true"
          :data-theme="mode"
        />
        <span class="sr-only">{{ selectedOption.label }}</span>
      </SelectValue>
    </SelectTrigger>
    <SelectContent>
      <SelectItem
        v-for="option in options"
        :key="option.value"
        :value="option.value"
      >
        <component :is="option.icon" aria-hidden="true" />
        <span class="sr-only">{{ option.label }}</span>
      </SelectItem>
    </SelectContent>
  </Select>
</template>
