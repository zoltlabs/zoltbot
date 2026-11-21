// The open Android text prompt. Android has no Alert.prompt, so `showPrompt` opens a sheet there;
// `PromptSheet` renders whatever is here.

export type OpenPrompt = {
  title: string;
  message?: string;
  defaultValue?: string;
  confirmLabel: string;
  /** Lets the person confirm with nothing typed. */
  optional?: boolean;
  onSubmit: (value: string) => void;
};

let open: OpenPrompt | undefined;
const listeners = new Set<() => void>();

export function openPromptSheet(prompt: OpenPrompt | undefined) {
  open = prompt;
  for (const listener of listeners) listener();
}

export const promptSheet = {
  get: () => open,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
