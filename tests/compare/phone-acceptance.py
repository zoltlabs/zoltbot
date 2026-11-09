"""Headless C5 acceptance. Requires a booted, separate simulator and compare-phone.ts fixture.
Never opens Simulator.app or sends host keyboard/mouse input. Pairing uses synthetic data only.
Usage: python3 tests/compare/phone-acceptance.py UDID output/compare/phone
"""
import json
import pathlib
import subprocess
import sys
import time

UDID, OUTPUT = sys.argv[1], pathlib.Path(sys.argv[2]).resolve()
IDB = "/opt/homebrew/bin/idb"


def ui(*args):
    result = subprocess.run([IDB, "ui", *args, "--udid", UDID, "--json", "--reason", "Synthetic headless Compare C5 acceptance"], capture_output=True, text=True)
    if result.returncode:
        # Do not leak a synthetic pairing URL through CalledProcessError's argv rendering.
        raise AssertionError(f"idb {args[0]} failed with status {result.returncode}")
    return json.loads(result.stdout) if result.stdout.strip() else None


def elements():
    return ui("describe-all")


def wait_label(label, timeout=30):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        rows = elements()
        candidates = [r for r in rows if r.get("AXLabel") == label or (r.get("type") == "TextArea" and str(r.get("AXLabel", "")).startswith(label + " "))]
        candidates.sort(key=lambda r: 0 if r.get("type") in ("TextField", "TextView", "TextArea") else 1)
        found = next(iter(candidates), None)
        if found:
            return found
        time.sleep(0.3)
    raise AssertionError(f"Missing UI label: {label}")


def tap(label):
    row = wait_label(label)
    assert row.get("enabled", True), f"Disabled UI label: {label}"
    if row.get("type") in ("TextField", "TextView", "TextArea"):
        frame = row["frame"]
        ui("tap", str(round(frame["x"] + frame["width"] / 2)), str(round(frame["y"] + frame["height"] / 2)))
    else:
        ui("tap", label)


def state():
    return json.loads((OUTPUT / "state.json").read_text())


def wait_state(predicate):
    until = time.monotonic() + 15
    while time.monotonic() < until:
        current = state()
        if predicate(current):
            return current
        time.sleep(0.2)
    raise AssertionError("Synthetic daemon state did not reach the expected result")


def screenshot(name):
    subprocess.run(["xcrun", "simctl", "io", UDID, "screenshot", str(OUTPUT / name)], check=True, capture_output=True)


if not any(d.get("state") == "paired" for d in state()["entities"].get("device", [])):
    if any(r.get("AXLabel") == "Enter the code instead" for r in elements()):
        tap("Enter the code instead")
    field = wait_label("Pairing link")
    frame = field["frame"]
    pairing_url = (OUTPUT / "pairing-url.txt").read_text()
    ui("set-value", str(round(frame["x"] + frame["width"] / 2)), str(round(frame["y"] + frame["height"] / 2)), "--value", pairing_url)
    until = time.monotonic() + 15
    while wait_label("Pairing link").get("AXValue") != pairing_url:
        if time.monotonic() > until:
            raise AssertionError("Pairing field did not retain the complete synthetic URL")
        time.sleep(0.2)
    tap("Pair")
    wait_state(lambda s: any(d.get("state") == "paired" for d in s["entities"].get("device", [])))
# This disposable test device does not need notification permission for Compare.
if any(r.get("AXLabel") == "Don’t Allow" for r in elements()):
    tap("Don’t Allow")
# Navigate through the production chat list, then test tabs and gesture navigation.
if not any(r.get("AXLabel") == "Continue with Second" for r in elements()):
    tap("Chats")
    tap("Compare phone acceptance, Compare · open")
wait_label("First")
tap("Second")
wait_label("Continue with Second")
screenshot("second-tab.png")
# Swipe based on this simulator's fresh application frame, not host coordinates.
frame = next(r["frame"] for r in elements() if r.get("type") == "Application")
ui("swipe", str(round(frame["width"] * 0.2)), str(round(frame["height"] * 0.45)), str(round(frame["width"] * 0.8)), str(round(frame["height"] * 0.45)), "--duration", "0.4")
wait_label("Continue with First")
tap("Second")
if next(m for m in state()["entities"]["compareMember"] if m["threadId"] == "phone-second")["vote"] != "better":
    tap("Better: Second")
wait_state(lambda s: next(m for m in s["entities"]["compareMember"] if m["threadId"] == "phone-second")["vote"] == "better")
field = wait_label("Follow up with all")
frame = field["frame"]
tap("Follow up with all")
ui("text", "Phone follow-up for both")
until = time.monotonic() + 15
while wait_label("Follow up with all").get("AXValue") != "Phone follow-up for both":
    if time.monotonic() > until:
        raise AssertionError("Follow-up field did not retain the complete message")
    time.sleep(0.2)
tap("Send to all")
result = wait_state(lambda s: len(s["received"]) == 2 and all(len(r["input"]) == 2 for r in s["received"]))
assert all(r["input"][1] == [{"type": "text", "text": "Phone follow-up for both"}] for r in result["received"])
assert result["permissions"] == ["read_only", "read_only"]
tap("Continue with Second")
result = wait_state(lambda s: s["entities"]["compare"][0]["state"] == "resolved")
assert result["entities"]["compare"][0]["resolution"]["threadId"] == "phone-second"
assert any(i["kind"] == "note" and i["threadId"] == "phone-second" and i.get("body", {}).get("code") == "compare" for i in result["entities"]["item"])
wait_label("View side by side")
screenshot("continued-second.png")
tap("View side by side")
wait_label("Second")
assert any(r.get("AXLabel") == "Send to all" and not r.get("enabled", True) for r in elements())
screenshot("resolved-compare.png")
(OUTPUT / "acceptance.json").write_text(json.dumps({"passed": ["tabs", "swipe", "better", "follow-up-all", "continue-second", "marker-route", "resolved-read-only"], "permissions": result["permissions"]}, indent=2))
print("C5 headless phone acceptance passed")
