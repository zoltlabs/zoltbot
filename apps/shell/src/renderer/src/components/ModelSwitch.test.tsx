import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import type { AgentPromptQuestion } from "../../../shared/ipc";
import { SwitchDialog } from "./ModelSwitch";

const questions: AgentPromptQuestion[] = [
  {
    id: "choice",
    header: "Provider",
    question: "",
    isSecret: false,
    options: [
      { label: "Continue on Codex", description: "" },
      { label: "Wait for the limit to reset", description: "" },
    ],
  },
  {
    id: "remember",
    header: "Next time",
    question: "",
    isSecret: false,
    options: [
      { label: "Don't ask again", description: "" },
      { label: "Ask next time", description: "" },
    ],
  },
];
const dialog = {
  from: "Claude · Personal",
  to: "Codex",
  provider: "Codex",
  until: "3:40 PM",
  project: "Acme app",
};

it("continues on the other provider and remembers the choice for the project", async () => {
  const onSubmit = vi.fn(async () => true);
  render(() => <SwitchDialog dialog={dialog} questions={questions} onSubmit={onSubmit} />);
  expect(screen.getByRole("dialog", { name: "Continue on Codex?" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Don't ask again for Acme app" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue on Codex" }));
  await Promise.resolve();
  expect(onSubmit).toHaveBeenCalledWith({
    choice: ["Continue on Codex"],
    remember: ["Don't ask again"],
  });
});

it("waits without remembering", async () => {
  const onSubmit = vi.fn(async () => true);
  render(() => <SwitchDialog dialog={dialog} questions={questions} onSubmit={onSubmit} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Don't ask again for Acme app" }));
  fireEvent.click(screen.getByRole("button", { name: "Wait until 3:40 PM" }));
  await Promise.resolve();
  expect(onSubmit).toHaveBeenCalledWith({
    choice: ["Wait for the limit to reset"],
    remember: ["Ask next time"],
  });
});
