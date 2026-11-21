import { describe, expect, it, vi } from "vitest";
import { BUNDLE_CHANNELS } from "../shared/bundle";

vi.mock("electron", () => ({ dialog: {} }));
const { bundleHandlers } = await import("./bundle-handlers");

describe("bundle handlers", () => {
  it("exports and previews only after the owner picks a file", async () => {
    const call = vi.fn(async (method: string) =>
      method === "import.bundle" ? { previewId: "bundle:1", agents: 2, items: [] } : {},
    );
    let path: string | undefined;
    const handlers = bundleHandlers({
      call,
      chooseSavePath: async () => path,
      chooseOpenPath: async () => path,
    });
    expect(await handlers[BUNDLE_CHANNELS.export]?.(undefined)).toEqual({ saved: false });
    expect(await handlers[BUNDLE_CHANNELS.preview]?.(undefined)).toBeNull();
    expect(call).not.toHaveBeenCalled();
    path = "/tmp/Zoltbot export.zip";
    expect(await handlers[BUNDLE_CHANNELS.export]?.(undefined)).toEqual({ saved: true });
    expect(call).toHaveBeenCalledWith("export.bundle", { path });
    expect(await handlers[BUNDLE_CHANNELS.preview]?.(undefined)).toMatchObject({ agents: 2 });
  });

  it("applies only a bundle's preview, with consent", async () => {
    const call = vi.fn(async () => ({}));
    const handlers = bundleHandlers({
      call,
      chooseSavePath: async () => undefined,
      chooseOpenPath: async () => undefined,
    });
    await expect(
      handlers[BUNDLE_CHANNELS.apply]?.({ previewId: "setup-1", selected: [] }),
    ).rejects.toThrow("invalid_preview");
    await handlers[BUNDLE_CHANNELS.apply]?.({ previewId: "bundle:1", selected: ["agent:a"] });
    expect(call).toHaveBeenCalledWith("import.apply", {
      previewId: "bundle:1",
      selected: ["agent:a"],
      consent: true,
    });
  });
});
