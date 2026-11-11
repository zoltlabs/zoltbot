(() => {
  let port,
    facts,
    nextId = 0,
    escapeAt = 0;
  const pending = new Map(),
    subscriptions = new Set(),
    events = new Map(),
    data = new Map();
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  function theme(value) {
    if (!value || !value.tokens) return;
    for (const [name, token] of Object.entries(value.tokens))
      if (name.startsWith("--zb-") && typeof token === "string")
        document.documentElement.style.setProperty(name, token);
    document.documentElement.dataset.theme = value.scheme;
    document.documentElement.style.setProperty("--zb-font-scale", String(value.fontScale));
  }
  const send = (message) => port?.postMessage(message);
  function receive(message) {
    if (!message || typeof message !== "object") return;
    if (message.t === "ready" && message.api === 1 && !facts) {
      facts = message;
      theme(message.theme);
      resolveReady(message);
      return;
    }
    if (message.t === "ping") {
      send({ t: "pong", id: message.id });
      return;
    }
    if (!facts) return;
    if (message.t === "result") {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.ok) call.resolve(message.value);
      else
        call.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    }
    if (message.t === "data") {
      data.set(message.topic, message.value);
      for (const sub of subscriptions)
        if (sub.topics.includes(message.topic)) sub.callback(message.topic, message.value);
    }
    if (message.t === "event") {
      if (message.name === "theme") theme(message.value);
      if (message.name === "grants") facts.granted = message.value;
      for (const callback of events.get(message.name) ?? []) callback(message.value);
    }
  }
  function connect(event) {
    if (
      port ||
      event.source !== window.parent ||
      event.data?.zolt !== "connect" ||
      !event.data.api?.includes(1) ||
      event.ports.length !== 1
    )
      return;
    port = event.ports[0];
    port.onmessage = (message) => receive(message.data);
    port.start();
    send({ t: "hello", api: 1 });
  }
  window.addEventListener("message", connect);
  async function call(method, params) {
    await ready;
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer =
        method === "requests.answer"
          ? undefined
          : setTimeout(() => {
              pending.delete(id);
              reject(Object.assign(new Error("The host did not answer."), { code: "unavailable" }));
            }, 30000);
      pending.set(id, { resolve, reject, timer });
      send({ t: "call", id, method, params });
    });
  }
  function topics() {
    return new Set([...subscriptions].flatMap((sub) => sub.topics));
  }
  let hostTopics = new Set();
  function syncTopics() {
    if (!facts) return;
    const next = topics(),
      added = [...next].filter((topic) => !hostTopics.has(topic)),
      removed = [...hostTopics].filter((topic) => !next.has(topic));
    if (added.length) send({ t: "sub", topics: added });
    if (removed.length) send({ t: "unsub", topics: removed });
    hostTopics = next;
  }
  function subscribe(wanted, callback) {
    const sub = { topics: [...new Set(wanted)], callback };
    subscriptions.add(sub);
    void ready.then(() => {
      if (!subscriptions.has(sub)) return;
      syncTopics();
      for (const topic of sub.topics) if (data.has(topic)) callback(topic, data.get(topic));
    });
    return () => {
      subscriptions.delete(sub);
      syncTopics();
    };
  }
  window.addEventListener(
    "keydown",
    (event) => {
      if (!facts) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        ["k", "b", "i", "j", ","].includes(event.key.toLowerCase())
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        send({ t: "key", combo: `mod+${event.key.toLowerCase()}` });
      }
      if (event.key === "Escape" && !event.repeat) {
        const now = Date.now();
        if (escapeAt && now - escapeAt <= 1000) {
          event.preventDefault();
          event.stopImmediatePropagation();
          send({ t: "key", combo: "escape-exit" });
          escapeAt = 0;
        } else escapeAt = now;
      }
    },
    true,
  );
  window.addEventListener("pagehide", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error("View closed."), { code: "unavailable" }));
    }
    pending.clear();
    port?.close();
  });
  window.zolt = Object.freeze({
    ready,
    get granted() {
      return Object.freeze([...(facts?.granted ?? [])]);
    },
    subscribe,
    on(name, callback) {
      const listeners = events.get(name) ?? new Set();
      listeners.add(callback);
      events.set(name, listeners);
      return () => listeners.delete(callback);
    },
    app: Object.freeze({ open: (target) => call("app.open", target) }),
    storage: Object.freeze({
      get: () => call("storage.get", {}),
      set: (value) => call("storage.set", { value }),
    }),
    chats: Object.freeze({
      send: (input) => call("chats.send", input),
      interrupt: (input) => call("chats.interrupt", input),
    }),
    requests: Object.freeze({ answer: (input) => call("requests.answer", input) }),
  });
})();
