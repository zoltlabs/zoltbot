// The command panel on the right of the console: requests for the selected chats, orders,
// and platform positions. Also loads and saves what the view remembers between sessions.
(() => {
  const node = (tag, text, parent) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    parent?.append(element);
    return element;
  };
  const button = (text, parent, action) => {
    const element = node("button", text, parent);
    element.type = "button";
    element.onclick = action;
    return element;
  };
  const submitButton = (form, text, action) => {
    const submit = () => {
      if (form.reportValidity()) action();
    };
    button(text, form, submit);
    form.onkeydown = (event) => {
      if (event.key === "Enter" && event.target.tagName !== "TEXTAREA") {
        event.preventDefault();
        submit();
      }
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      submit();
    };
  };
  window.commandMapSaved = (input) => {
    const value = input && typeof input === "object" ? input : {};
    const regions = {},
      groups = {};
    for (const [id, point] of Object.entries(value.regions ?? {}).slice(0, 500)) {
      if (
        point &&
        Number.isFinite(point.x) &&
        Number.isFinite(point.z) &&
        Math.abs(point.x) <= 100000 &&
        Math.abs(point.z) <= 100000
      )
        Object.defineProperty(regions, id, {
          value: { x: point.x, z: point.z },
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    for (const id of ["1", "2", "3"]) {
      const list = value.groups?.[id];
      if (Array.isArray(list))
        groups[id] = [...new Set(list.filter((item) => typeof item === "string"))].slice(0, 500);
    }
    return {
      regions,
      groups,
      presets:
        Array.isArray(value.presets) && value.presets.length === 2
          ? value.presets.map((text, index) =>
              typeof text === "string" && text.trim() && text.length <= 8000
                ? text
                : ["Rebase on main", "Run the tests"][index],
            )
          : ["Rebase on main", "Run the tests"],
      // Sound is off unless the owner turned it on. Graphics is automatic unless they chose a level.
      sound: value.sound === true ? true : undefined,
      // The chat list is shown unless the owner hid it.
      list: value.list === false ? false : undefined,
      quality: ["high", "medium", "low"].includes(value.quality) ? value.quality : undefined,
    };
  };
  window.CommandMapPanel = class {
    constructor(host, saved) {
      this.host = host;
      this.saved = window.commandMapSaved(saved);
      this.container = document.querySelector("#actions");
      this.signature = "";
      this.writes = Promise.resolve();
      this.busy = false;
      this.keys = (event) => {
        if (
          event.target.matches("input,textarea,button,select") ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey
        )
          return;
        const digit = /^Digit([1-3])$/.exec(event.code);
        if (digit) {
          event.preventDefault();
          if (event.shiftKey) this.saveGroup(digit[1]);
          else this.recallGroup(digit[1]);
        }
        if (event.key === "Escape") this.host.select([]);
      };
      window.addEventListener("keydown", this.keys);
    }
    save() {
      const value = JSON.parse(JSON.stringify(this.saved));
      this.writes = this.writes
        .catch(() => {})
        .then(() => window.zolt.storage.set(value))
        .catch(this.host.error);
    }
    saveGroup(id) {
      this.saved.groups[id] = [...this.host.selected()];
      this.save();
      this.host.groups();
    }
    recallGroup(id) {
      const known = new Set(this.host.topics.chats.map((chat) => chat.id));
      this.host.select((this.saved.groups[id] ?? []).filter((chat) => known.has(chat)));
    }
    move(id, x, z) {
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(z) ||
        Math.abs(x) > 100000 ||
        Math.abs(z) > 100000
      )
        return;
      Object.defineProperty(this.saved.regions, id, {
        value: { x, z },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.save();
      this.host.layout();
      this.signature = "";
      this.render();
    }
    async perform(action) {
      if (this.busy) return;
      this.busy = true;
      this.host.error({ message: "" });
      const focusedName = this.container.contains(document.activeElement)
        ? document.activeElement.textContent
        : "";
      const controls = [...this.container.querySelectorAll("button")];
      for (const control of controls) control.disabled = true;
      try {
        const result = await action();
        if (Array.isArray(result)) {
          const skipped = result.filter((row) => row.result === "skipped");
          document.querySelector("#live").textContent = skipped.length
            ? `${skipped.length} chats skipped. ${skipped.map((row) => row.reason).join(" ")}`
            : "Order sent.";
        }
      } catch (error) {
        this.host.error(error);
      } finally {
        this.busy = false;
        this.signature = "";
        this.render();
        if (focusedName) {
          const target =
            [...this.container.querySelectorAll("button")].find(
              (button) => button.textContent === focusedName,
            ) ?? this.container.querySelector("h2");
          if (target) {
            if (target.tagName !== "BUTTON") target.tabIndex = -1;
            target.focus({ preventScroll: true });
          }
        }
      }
    }
    primitive(parent, title, schema, required = true) {
      const label = node("label", title, parent);
      let input, read;
      if (Array.isArray(schema?.enum)) {
        input = node("select", undefined, label);
        if (!required) {
          const option = node("option", "Not set", input);
          option.value = "";
        }
        schema.enum.forEach((value, index) => {
          const option = node("option", String(value), input);
          option.value = String(index);
        });
        read = () => (input.value === "" ? undefined : schema.enum[Number(input.value)]);
      } else if (schema?.type === "boolean") {
        input = node("select", undefined, label);
        for (const [value, text] of [
          ["", "Choose…"],
          ["true", "Yes"],
          ["false", "No"],
        ]) {
          const option = node("option", text, input);
          option.value = value;
        }
        read = () => (input.value === "" ? undefined : input.value === "true");
      } else {
        input = node("input", undefined, label);
        input.type = ["number", "integer"].includes(schema?.type) ? "number" : "text";
        if (input.type === "number") {
          input.step = schema.type === "integer" ? "1" : "any";
          if (schema.minimum !== undefined) input.min = String(schema.minimum);
          if (schema.maximum !== undefined) input.max = String(schema.maximum);
        } else {
          if (schema?.minLength !== undefined) input.minLength = schema.minLength;
          if (schema?.maxLength !== undefined) input.maxLength = schema.maxLength;
        }
        read = () =>
          !required && input.value === ""
            ? undefined
            : input.type === "number"
              ? input.value === ""
                ? undefined
                : Number(input.value)
              : input.value;
      }
      input.required = required;
      if (schema?.description) node("p", schema.description, label);
      return read;
    }
    question(parent, question, type) {
      const group = node("fieldset", undefined, parent);
      node("legend", question.label, group);
      if (type === "form") {
        const schema = question.schema;
        if (!schema || typeof schema !== "object") return null;
        if (schema.type !== "object") {
          const read = this.primitive(group, schema.title ?? "Response", schema);
          return () => ({ value: read() });
        }
        const fields = Object.entries(schema.properties ?? {}).map(([key, shape]) => [
          key,
          this.primitive(group, shape.title ?? key, shape, (schema.required ?? []).includes(key)),
        ]);
        return () => ({
          value: Object.fromEntries(
            fields.map(([key, read]) => [key, read()]).filter(([, value]) => value !== undefined),
          ),
        });
      }
      const options = [];
      for (const option of question.options ?? []) {
        const label = node("label", option.label, group),
          input = node("input", undefined, label);
        input.type = question.multi ? "checkbox" : "radio";
        input.name = question.id;
        input.value = option.id;
        input.onchange = () => {
          if (input.checked && !question.multi && other) other.value = "";
        };
        options.push(input);
      }
      let other;
      if (question.freeText) {
        const label = node("label", options.length ? "Other" : "Response", group);
        other = node("textarea", undefined, label);
        other.maxLength = 8000;
        other.oninput = () => {
          if (!question.multi && other.value.trim())
            for (const option of options) option.checked = false;
        };
      }
      return () => {
        const selected = options.filter((option) => option.checked).map((option) => option.value);
        if (other?.value.trim())
          return { options: question.multi ? selected : [], other: other.value };
        return question.multi ? selected : (selected[0] ?? "");
      };
    }
    request(request, parent) {
      const section = node("section", undefined, parent);
      node("h3", request.title, section);
      if (request.context?.command) node("pre", request.context.command, section);
      if (request.context?.markdown) node("p", request.context.markdown, section);
      const open = () => window.zolt.app.open({ chatId: request.chatId }).catch(this.host.error);
      if (!window.zolt.granted.includes("approve") || request.answerInChat) {
        button("Open chat", section, open);
        return;
      }
      for (const choice of request.choices)
        button(choice.label, section, () =>
          this.perform(() =>
            window.zolt.requests.answer({
              requestId: request.id,
              version: request.version,
              choiceId: choice.id,
            }),
          ),
        );
      if (["question", "form"].includes(request.type)) {
        if (!request.questions?.length) {
          button("Open chat", section, open);
          return;
        }
        const form = node("form", undefined, section);
        form.setAttribute("aria-label", `Answer: ${request.title}`);
        const fields = request.questions.map((question) => [
          question.id,
          this.question(form, question, request.type),
        ]);
        if (fields.some(([, read]) => !read)) {
          form.remove();
          button("Open chat", section, open);
          return;
        }
        submitButton(
          form,
          "Send answer",
          () =>
            void this.perform(() =>
              window.zolt.requests.answer({
                requestId: request.id,
                version: request.version,
                answers: Object.fromEntries(fields.map(([id, read]) => [id, read()])),
              }),
            ),
        );
      }
    }
    render() {
      const selected = this.host.selected(),
        requests = this.host.topics.requests.filter((request) => selected.has(request.chatId));
      const signature = JSON.stringify([
        [...selected],
        requests,
        window.zolt.granted,
        this.host.regions().map(({ id, name, x, z }) => ({ id, name, x, z })),
      ]);
      if (this.signature === signature || this.busy) return;
      this.signature = signature;
      const active = document.activeElement?.dataset?.panelFocus;
      const wasOpen = !!this.container.querySelector("details")?.open;
      this.container.replaceChildren();
      if (requests.length) {
        const panel = node("section", undefined, this.container);
        node("h2", "Requests", panel);
        for (const request of requests) this.request(request, panel);
      }
      if (window.zolt.granted.includes("act")) {
        const orders = node("section", undefined, this.container);
        orders.className = "orders";
        node("h2", "Orders", orders);
        if (selected.size > 50) node("p", "Select up to 50 chats to send an order.", orders);
        this.saved.presets.forEach((text, index) => {
          const label = node("label", `Preset ${index + 1}`, orders),
            input = node("textarea", text, label);
          input.rows = 1;
          input.dataset.panelFocus = `preset-${index}`;
          input.maxLength = 8000;
          input.onchange = () => {
            if (!input.value.trim()) {
              input.value = this.saved.presets[index];
              return;
            }
            this.saved.presets[index] = input.value;
            this.save();
          };
          button(`Send preset ${index + 1}`, orders, () =>
            this.perform(() =>
              window.zolt.chats.send({ chatIds: [...selected], text: input.value }),
            ),
          ).disabled = !selected.size || selected.size > 50;
        });
        button("Stop selected chats", orders, () =>
          this.perform(() => window.zolt.chats.interrupt({ chatIds: [...selected] })),
        ).disabled = !selected.size || selected.size > 50;
      }
      const layout = node("details", undefined, this.container);
      node("summary", "Region positions", layout);
      layout.open = wasOpen;
      for (const region of this.host.regions()) {
        const form = node("form", undefined, layout);
        form.setAttribute("aria-label", `Position for ${region.name}`);
        node("h3", region.name, form);
        const x = this.primitive(form, "Horizontal position", {
          type: "number",
          minimum: -100000,
          maximum: 100000,
        });
        const z = this.primitive(form, "Vertical position", {
          type: "number",
          minimum: -100000,
          maximum: 100000,
        });
        const inputs = form.querySelectorAll("input");
        inputs[0].value = String(region.x);
        inputs[1].value = String(region.z);
        submitButton(form, "Move region", () => this.move(region.id, x(), z()));
      }
      if (active)
        for (const input of this.container.querySelectorAll("[data-panel-focus]"))
          if (input.dataset.panelFocus === active) input.focus();
    }
    dispose() {
      window.removeEventListener("keydown", this.keys);
    }
  };
})();
