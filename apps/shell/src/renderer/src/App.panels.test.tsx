import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { setUpAppTest } from "./app-test-harness";

describe("Zoltbot connected desktop shell", () => {
  beforeEach(setUpAppTest);

  it("fully hides and restores the left sidebar without losing its width", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    const frame = screen.getByRole("main", { name: "Conversation" }).closest(".app-frame");
    const sidebarToggle = screen.getByRole("button", { name: "Hide sidebar" });
    expect(sidebarToggle).toHaveClass("sidebar-icon-button");
    expect(sidebarToggle).toHaveAttribute("aria-expanded", "true");
    await fireEvent.click(sidebarToggle);

    expect(screen.queryByRole("complementary", { name: "Bot navigation" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("separator", { name: "Resize left sidebar" }),
    ).not.toBeInTheDocument();
    expect(frame).toHaveClass("app-frame-sidebar-collapsed");
    expect(frame).toHaveStyle("--left-panel-width: 0px");
    expect(window.localStorage.getItem("openbot:left-panel-collapsed")).toBe("true");
    const restoreSidebar = screen.getByRole("button", { name: "Show sidebar" });
    expect(restoreSidebar).toHaveClass("sidebar-icon-button");
    expect(restoreSidebar).toHaveAttribute("aria-expanded", "false");

    await fireEvent.click(restoreSidebar);

    expect(screen.getByRole("complementary", { name: "Bot navigation" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize left sidebar" })).toHaveAttribute(
      "aria-valuenow",
      "275",
    );
    expect(frame).not.toHaveClass("app-frame-sidebar-collapsed");
    expect(window.localStorage.getItem("openbot:left-panel-collapsed")).toBe("false");
    expect(screen.getByRole("button", { name: "Hide sidebar" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("closes settings on agent switch but restores browser panels", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    expect(screen.getByRole("complementary", { name: "Agent settings" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /^Sales Outbound/ }));
    expect(screen.queryByRole("complementary", { name: "Agent settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open browser" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
    expect(screen.getByRole("complementary", { name: "Browser" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /^Chief/ }));
    expect(screen.queryByRole("complementary", { name: "Agent settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Browser" })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /^Sales Outbound/ }));
    expect(screen.getByRole("complementary", { name: "Browser" })).toBeInTheDocument();
  });
});
