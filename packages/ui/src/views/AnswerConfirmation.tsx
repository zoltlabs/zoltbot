import type { Request } from "@zoltbot/view-api";
import { useEffect, useRef, useState } from "react";
import { Button, Dialog } from "../components/primitives.js";

type Pending = {
  request: Request;
  choice: Request["choices"][number];
  finish(value: boolean): void;
};
export function useAnswerConfirmation() {
  const [pending, setPending] = useState<Pending | undefined>();
  const active = useRef<Pending | undefined>(undefined);
  function finish(value: boolean) {
    active.current?.finish(value);
    active.current = undefined;
    setPending(undefined);
  }
  useEffect(
    () => () => {
      active.current?.finish(false);
      active.current = undefined;
    },
    [],
  );
  function confirm(request: Request, choice: Request["choices"][number]) {
    if (active.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const next = { request, choice, finish: resolve };
      active.current = next;
      setPending(next);
    });
  }
  return {
    confirm,
    dialog: pending ? (
      <Dialog
        open
        title={pending.request.title}
        onClose={() => finish(false)}
        actions={
          <>
            <Button onClick={() => finish(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => finish(true)}>
              Confirm
            </Button>
          </>
        }
      >
        {pending.request.context?.command ? <pre>{pending.request.context.command}</pre> : null}
        <p>{pending.choice.label}</p>
      </Dialog>
    ) : null,
  };
}
