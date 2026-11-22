// Requests and orders: renders a request with its answers (or a form for questions), sends
// answers and messages, and loads and saves what the view remembers between sessions.
(() => {
  const map = window.CommandMap,
    { el } = map;
  const DEFAULT_MESSAGES = ["Rebase on main", "Run the tests"];
  window.commandMapSaved = (input) => {
    const value = input && typeof input === "object" ? input : {};
    const messages = Array.isArray(value.presets)
      ? value.presets
          .filter((text) => typeof text === "string" && text.trim() && text.length <= 8000)
          .slice(0, 6)
      : [];
    return {
      // Saved messages, sent to the selected chats. "presets" is the name older versions used.
      presets: messages.length ? messages : [...DEFAULT_MESSAGES],
      // Sound is off unless the owner turned it on.
      sound: value.sound === true ? true : undefined,
    };
  };
  const button = (text, attributes, action) => {
    const element = el("button", { type: "button", ...attributes }, text);
    element.onclick = action;
    return element;
  };
  const refuses = (choice) => /reject|deny|decline|cancel/i.test(`${choice.id} ${choice.label}`);

  map.Actions = class {
    // host: { error(error), say(text), open(chatId), changed() }
    constructor(host, saved) {
      this.host = host;
      this.saved = window.commandMapSaved(saved);
      this.writes = Promise.resolve();
      this.busy = false;
    }
    save() {
      const value = JSON.parse(JSON.stringify(this.saved));
      this.writes = this.writes
        .catch(() => {})
        .then(() => window.zolt.storage.set(value))
        .catch(this.host.error);
    }
    can(permission) {
      return window.zolt.granted.includes(permission);
    }
    // Runs one call at a time, with every action button disabled until it settles.
    async perform(action, done = "") {
      if (this.busy) return;
      this.busy = true;
      this.host.error({ message: "" });
      for (const control of document.querySelectorAll("[data-action]")) control.disabled = true;
      try {
        const result = await action();
        if (Array.isArray(result)) {
          const skipped = result.filter((row) => row.result === "skipped");
          this.host.say(
            skipped.length
              ? `${skipped.length} chat${skipped.length === 1 ? "" : "s"} skipped. ${skipped.map((row) => row.reason).join(" ")}`
              : done,
          );
        } else if (done) this.host.say(done);
      } catch (error) {
        this.host.error(error);
      } finally {
        this.busy = false;
        for (const control of document.querySelectorAll("[data-action]")) control.disabled = false;
        this.host.changed();
      }
    }
    answer(request, extra) {
      return this.perform(
        () => window.zolt.requests.answer({ requestId: request.id, version: request.version, ...extra }),
        "Answer sent.",
      );
    }
    send(chatIds, text) {
      return this.perform(() => window.zolt.chats.send({ chatIds, text }), "Message sent.");
    }
    stop(chatIds) {
      return this.perform(() => window.zolt.chats.interrupt({ chatIds }), "Stopped.");
    }
    // A request card: title, what it wants to run or change, and its answers.
    request(request, chat, options = {}) {
      const card = el("article", {
        class: "ask",
        "data-request": request.id,
        "data-since": request.createdAt,
      });
      const head = el("div", { class: "ask-head" }, map.icon("needs_you"), el("h3", {}, request.title));
      head.append(
        el("span", { class: "wait" }, map.waited(Date.parse(request.createdAt) || Date.now()).short),
      );
      card.append(head);
      if (options.who && chat) {
        const who = button(chat.title, { class: "who", "aria-label": `Show ${chat.title} on the map` }, () =>
          options.who(chat.id),
        );
        card.append(who);
      }
      if (request.context?.command) card.append(el("pre", {}, request.context.command));
      if (request.context?.markdown) card.append(el("p", { class: "context" }, request.context.markdown));
      const open = () => this.host.open(request.chatId);
      const row = el("div", { class: "actions" });
      card.append(row);
      if (!this.can("approve") || request.answerInChat) {
        row.append(button("Open chat", { "aria-label": `Open chat: ${chat?.title ?? request.title}` }, open));
        return card;
      }
      (request.choices ?? []).forEach((choice, index) => {
        row.append(
          button(
            choice.label,
            {
              class: refuses(choice) ? "danger" : index === 0 ? "primary" : "",
              "data-action": "",
            },
            () => this.answer(request, { choiceId: choice.id }),
          ),
        );
      });
      if (["question", "form"].includes(request.type)) {
        const form = this.form(request);
        if (form) card.append(form);
        else row.append(button("Open chat", {}, open));
      }
      return card;
    }
    form(request) {
      if (!request.questions?.length) return null;
      const form = el("form", { "aria-label": `Answer: ${request.title}` });
      const fields = request.questions.map((question) => [question.id, this.question(form, question, request.type)]);
      if (fields.some(([, read]) => !read)) return null;
      const submit = () => {
        if (form.reportValidity())
          void this.answer(request, {
            answers: Object.fromEntries(fields.map(([id, read]) => [id, read()])),
          });
      };
      form.append(button("Send answer", { class: "primary", "data-action": "" }, submit));
      form.onsubmit = (event) => {
        event.preventDefault();
        submit();
      };
      return form;
    }
    field(parent, title, schema, required = true) {
      const label = el("label", {}, title);
      parent.append(label);
      let input, read;
      if (Array.isArray(schema?.enum) || schema?.type === "boolean") {
        input = el("select");
        const options = Array.isArray(schema.enum)
          ? schema.enum.map((value, index) => [String(index), String(value)])
          : [
              ["true", "Yes"],
              ["false", "No"],
            ];
        input.append(el("option", { value: "" }, required ? "Choose…" : "Not set"));
        for (const [value, text] of options) input.append(el("option", { value }, text));
        read = () =>
          input.value === ""
            ? undefined
            : Array.isArray(schema.enum)
              ? schema.enum[Number(input.value)]
              : input.value === "true";
      } else {
        const number = ["number", "integer"].includes(schema?.type);
        input = el("input", { type: number ? "number" : "text" });
        if (number) {
          input.step = schema.type === "integer" ? "1" : "any";
          if (schema.minimum !== undefined) input.min = String(schema.minimum);
          if (schema.maximum !== undefined) input.max = String(schema.maximum);
        } else {
          if (schema?.minLength !== undefined) input.minLength = schema.minLength;
          if (schema?.maxLength !== undefined) input.maxLength = schema.maxLength;
        }
        read = () =>
          input.value === "" ? undefined : number ? Number(input.value) : input.value;
      }
      input.required = required;
      label.append(input);
      if (schema?.description) label.append(el("span", { class: "hint" }, schema.description));
      return read;
    }
    question(parent, question, type) {
      const group = el("fieldset", {}, el("legend", {}, question.label));
      parent.append(group);
      if (type === "form") {
        const schema = question.schema;
        if (!schema || typeof schema !== "object") return null;
        if (schema.type !== "object") {
          const read = this.field(group, schema.title ?? "Response", schema);
          return () => ({ value: read() });
        }
        const fields = Object.entries(schema.properties ?? {}).map(([key, shape]) => [
          key,
          this.field(group, shape.title ?? key, shape, (schema.required ?? []).includes(key)),
        ]);
        return () => ({
          value: Object.fromEntries(
            fields.map(([key, read]) => [key, read()]).filter(([, value]) => value !== undefined),
          ),
        });
      }
      const options = [];
      let other;
      for (const option of question.options ?? []) {
        const input = el("input", {
          type: question.multi ? "checkbox" : "radio",
          name: question.id,
          value: option.id,
        });
        input.onchange = () => {
          if (input.checked && !question.multi && other) other.value = "";
        };
        group.append(el("label", { class: "choice" }, input, option.label));
        options.push(input);
      }
      if (question.freeText) {
        other = el("textarea", { maxlength: "8000", rows: "2" });
        other.oninput = () => {
          if (!question.multi && other.value.trim()) for (const option of options) option.checked = false;
        };
        group.append(el("label", {}, options.length ? "Other" : "Response", other));
      }
      return () => {
        const chosen = options.filter((option) => option.checked).map((option) => option.value);
        if (other?.value.trim()) return { options: question.multi ? chosen : [], other: other.value };
        return question.multi ? chosen : (chosen[0] ?? "");
      };
    }
    // Orders for the selection: one message box, the saved messages, and Stop.
    orders(chatIds) {
      const section = el("section", { class: "orders", "aria-label": "Orders" });
      if (!this.can("act")) return null;
      const many = chatIds.length > 50;
      if (many) section.append(el("p", { class: "hint" }, "Select up to 50 chats to send a message."));
      const count = chatIds.length === 1 ? "this chat" : `all ${chatIds.length}`;
      const text = el("textarea", { rows: "2", maxlength: "8000", "data-keep": "message" });
      text.value = this.draft ?? "";
      text.oninput = () => (this.draft = text.value);
      section.append(el("label", { class: "message" }, `Message ${count}`, text));
      const saved = el("div", { class: "saved", role: "group", "aria-label": "Saved messages" });
      for (const message of this.saved.presets)
        saved.append(
          button(message, { class: "chip-button", title: "Put this message in the box" }, () => {
            text.value = message;
            this.draft = message;
            text.focus();
          }),
        );
      saved.append(
        button("Save message", { class: "quiet" }, () => {
          const value = text.value.trim();
          if (!value || this.saved.presets.includes(value)) return;
          this.saved.presets = [value, ...this.saved.presets].slice(0, 6);
          this.save();
          this.host.changed();
        }),
      );
      section.append(saved);
      const row = el("div", { class: "actions" });
      const send = button(
        chatIds.length === 1 ? "Send" : `Send to ${chatIds.length}`,
        { class: "primary", "data-action": "" },
        () => {
          if (!text.value.trim()) {
            text.focus();
            return;
          }
          void this.send(chatIds, text.value).then(() => {
            this.draft = "";
          });
        },
      );
      const stop = button(chatIds.length === 1 ? "Stop" : "Stop all", { class: "danger", "data-action": "" }, () =>
        this.stop(chatIds),
      );
      send.disabled = stop.disabled = many || this.busy;
      row.append(send, stop);
      section.append(row);
      return section;
    }
  };
})();
