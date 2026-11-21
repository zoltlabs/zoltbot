// P9: gives this phone's push token to the relay of every paired Mac, and again whenever the
// token or the set of Macs changes. Each relay keeps it beside the device record, and the
// transport sends it again after every reconnect.
import { relayOf, useLink } from "./link";
import { usePush } from "./push";

let started = false;

function register() {
  const { token, platform } = usePush.getState();
  if (!token || !platform) return;
  for (const client of Object.values(useLink.getState().clients))
    relayOf(client)?.register("push.register", platform, token);
}

/** Call once the link has booted. */
export function startPushRegistration(): void {
  if (started) return;
  started = true;
  register();
  usePush.subscribe((state, before) => {
    if (state.token !== before.token || state.platform !== before.platform) register();
  });
  useLink.subscribe((state, before) => {
    if (state.clients !== before.clients) register();
  });
  // Without asking: the prompt comes when the owner pairs a Mac.
  void usePush
    .getState()
    .refresh()
    .catch(() => undefined);
}
