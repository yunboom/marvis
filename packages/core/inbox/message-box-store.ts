import { create } from "zustand";

/**
 * Whether the message box (the inbox shown as a dialog over the current page)
 * is open. Kept apart from `useModalStore`: that store holds one modal at a
 * time, and the issue detail inside the message box opens its own modals
 * (rename, delete, set parent) on top of it.
 */
interface MessageBoxState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useMessageBoxStore = create<MessageBoxState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
