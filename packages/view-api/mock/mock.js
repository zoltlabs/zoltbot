(() => {
  window.createZoltViewMock = (receive, clientUrl, unavailable) => {
    const values = window.zoltMockData(),
      subscribed = new Set();
    const view = window.zoltMockView ?? {
      id: "mock-view",
      name: document.title || "View",
      version: "1.0.0",
    };
    const granted = window.zoltMockPermissions ?? ["read", "act", "approve"];
    const stateKey = `zoltbot.view-mock.${view.id}`;
    let closed = false,
      interval,
      delivery,
      tick = 0;
    const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
    const deliver = (value) => {
      if (!closed) receive(clone(value));
    };
    function publish() {
      values.usage.activeChats = values.chats.filter((chat) =>
        ["working", "needs_you"].includes(chat.status),
      ).length;
      if (delivery || closed) return;
      delivery = setTimeout(() => {
        delivery = undefined;
        for (const topic of subscribed)
          deliver({ t: "data", topic, value: values[topic], at: new Date().toISOString() });
      }, 100);
    }
    function fail(code, message) {
      throw Object.assign(new Error(message), { code });
    }
    async function theme() {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = new URL("tokens.css", clientUrl).href;
      await new Promise((resolve, reject) => {
        link.onload = resolve;
        link.onerror = reject;
        document.head.append(link);
      });
      const root = document.documentElement;
      root.dataset.theme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      const style = getComputedStyle(root),
        tokens = {};
      for (const name of Array.from(style))
        if (name.startsWith("--zb-") && !/^--zb-(?:gray-|indigo-|ink$)/.test(name))
          tokens[name] = style.getPropertyValue(name).trim();
      return {
        scheme: root.dataset.theme,
        tokens,
        fontSans: style.getPropertyValue("--zb-font-sans").trim(),
        fontMono: style.getPropertyValue("--zb-font-mono").trim(),
        fontScale: 1,
      };
    }
    function act(method, params) {
      const permission = {
        "storage.get": "read",
        "storage.set": "read",
        "app.open": "read",
        "chats.send": "act",
        "chats.interrupt": "act",
        "requests.answer": "approve",
      }[method];
      if (permission && !granted.includes(permission))
        fail("not_granted", `This view needs the ${permission} permission.`);
      if (method === "storage.get") {
        try {
          return JSON.parse(localStorage.getItem(stateKey) ?? "null");
        } catch {
          return null;
        }
      }
      if (method === "storage.set") {
        const json = JSON.stringify(params.value);
        if (json === undefined || new TextEncoder().encode(json).length > 256 * 1024)
          fail("invalid", "Saved state must be JSON no larger than 256 KB.");
        localStorage.setItem(stateKey, json);
        return;
      }
      if (method === "app.open") {
        window.dispatchEvent(new CustomEvent("zolt:mock-open", { detail: params }));
        return;
      }
      if (method === "chats.send" || method === "chats.interrupt") {
        if (
          !Array.isArray(params.chatIds) ||
          !params.chatIds.length ||
          params.chatIds.length > 50 ||
          new Set(params.chatIds).size !== params.chatIds.length
        )
          fail("invalid", "Choose 1 to 50 chats.");
        if (
          method === "chats.send" &&
          (typeof params.text !== "string" || !params.text.trim() || params.text.length > 8000)
        )
          fail("invalid", "Enter a message of up to 8,000 characters.");
        return params.chatIds.map((id) => {
          const chat = values.chats.find((row) => row.id === id);
          if (!chat) return { chatId: id, result: "skipped", reason: "Chat not found." };
          const running = chat.status === "working";
          if (method === "chats.interrupt" && !running)
            return { chatId: id, result: "skipped", reason: "No running turn." };
          chat.status = method === "chats.send" ? "working" : "idle";
          chat.updatedAt = new Date().toISOString();
          chat.lastTurn = {
            status: method === "chats.send" ? "running" : "interrupted",
            ...(method === "chats.interrupt" ? { endedAt: chat.updatedAt } : {}),
          };
          chat.activity = method === "chats.send" ? "Working on your order" : undefined;
          return {
            chatId: id,
            result: method === "chats.send" ? (running ? "queued" : "started") : "interrupted",
          };
        });
      }
      if (method === "requests.answer") {
        const request = values.requests.find((row) => row.id === params.requestId);
        if (!request) fail("not_found", "Request not found.");
        if (request.version !== params.version)
          fail("stale", "This request changed. Read it again.");
        if (
          request.choices.length &&
          !request.choices.some((choice) => choice.id === params.choiceId)
        )
          fail("invalid", "This choice was not offered.");
        values.requests = values.requests.filter((row) => row !== request);
        const chat = values.chats.find((row) => row.id === request.chatId);
        if (chat) {
          chat.status = "working";
          chat.requestIds = [];
          chat.updatedAt = new Date().toISOString();
        }
        return;
      }
      fail("invalid", "Unknown view call.");
    }
    const visibility = () => deliver({ t: "event", name: "visibility", value: !document.hidden });
    document.addEventListener("visibilitychange", visibility);
    return {
      start() {},
      postMessage(message) {
        if (closed) return;
        if (message.t === "hello") {
          void theme()
            .then((theme) => {
              if (closed) return;
              deliver({
                t: "ready",
                api: 1,
                view,
                granted,
                theme,
                locale: navigator.language,
                reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
                mock: true,
              });
              interval = setInterval(() => {
                if (document.hidden) return;
                tick++;
                values.usage.today.costUsd =
                  Math.round((values.usage.today.costUsd + 0.01) * 100) / 100;
                values.usage.today.inputTokens += 50;
                values.chats[0].status = ["working", "review", "idle"][tick % 3];
                values.chats[0].updatedAt = new Date().toISOString();
                if (!values.requests.length) {
                  values.requests.push({
                    id: `demo-request-${tick}`,
                    version: 1,
                    chatId: "demo-check",
                    type: "question",
                    title: "What should run next?",
                    urgency: "blocking",
                    createdAt: new Date().toISOString(),
                    choices: [],
                    questions: [
                      {
                        id: "next",
                        label: "Next step",
                        options: [
                          { id: "tests", label: "Run tests" },
                          { id: "review", label: "Review the page" },
                        ],
                        freeText: true,
                      },
                    ],
                  });
                  values.chats[1].status = "needs_you";
                  values.chats[1].requestIds = [values.requests[0].id];
                }
                values.usage.activeChats = values.chats.filter((chat) =>
                  ["working", "needs_you"].includes(chat.status),
                ).length;
                values.checks[0].state = tick % 2 ? "failing" : "passing";
                publish();
              }, 5000);
            })
            .catch(() => unavailable?.());
        } else if (message.t === "sub" || message.t === "unsub") {
          for (const topic of message.topics)
            if (Object.hasOwn(values, topic)) {
              if (message.t === "sub") subscribed.add(topic);
              else subscribed.delete(topic);
            }
          publish();
        } else if (message.t === "call") {
          try {
            const value = act(message.method, message.params ?? {});
            deliver({ t: "result", id: message.id, ok: true, value });
            publish();
          } catch (error) {
            deliver({
              t: "result",
              id: message.id,
              ok: false,
              error: {
                code: ["invalid", "not_granted", "not_found", "stale"].includes(error.code)
                  ? error.code
                  : "unavailable",
                message: error.message,
              },
            });
          }
        } else if (message.t === "key" && message.combo === "escape-exit") window.focus();
      },
      close() {
        closed = true;
        clearTimeout(delivery);
        clearInterval(interval);
        document.removeEventListener("visibilitychange", visibility);
      },
    };
  };
})();
