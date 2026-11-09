import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
export class AcpSettings {
  private options: SessionConfigOption[] = [];
  update(options: SessionConfigOption[]) {
    this.options = options;
  }
  private select(category: string) {
    return this.options.find((o) => o.category === category && o.type === "select");
  }
  private choices(category: string): SessionConfigSelectOption[] {
    const option = this.select(category);
    return option?.type === "select"
      ? option.options.flatMap((o) => ("group" in o ? o.options : [o]))
      : [];
  }
  get currentMode() {
    const option = this.select("mode");
    return option?.currentValue;
  }
  get hasModes() {
    return this.select("mode") !== undefined;
  }
  get modes() {
    return this.choices("mode").map((option) => option.value);
  }
  modeSelection(mode: string) {
    const option = this.select("mode");
    if (!option) return undefined;
    if (!this.modes.includes(mode)) throw new Error("unsupported_mode");
    return { configId: option.id, value: mode };
  }
  get models() {
    return this.choices("model").map((o) => ({ id: o.value, name: o.name }));
  }
  get effort() {
    return this.choices("thought_level").map((o) => o.value);
  }
  selection(model: string, effort?: string) {
    const option = this.select("model");
    if (!option || !this.models.some((o) => o.id === model))
      throw new Error("unsupported_model_selection");
    const result = [{ configId: option.id, value: model }];
    if (effort) {
      const option = this.select("thought_level");
      if (!option || !this.effort.includes(effort)) throw new Error("unsupported_effort");
      result.push({ configId: option.id, value: effort });
    }
    return result;
  }
}
