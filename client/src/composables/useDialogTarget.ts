import { shallowReactive } from "vue";

export interface DialogTarget<T> {
  target: T | null;
  open: boolean;
  ask(value: T): void;
}

export function useDialogTarget<T>(): DialogTarget<T> {
  const dialog: DialogTarget<T> = shallowReactive({
    target: null,
    open: false,
    ask(value: T) {
      dialog.target = value;
      dialog.open = true;
    },
  });
  return dialog;
}
