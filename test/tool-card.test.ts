// Tool cards show a hostname's live state while it is in the table, and label the state
// from when the tool ran once it is not, so an old state never reads as current.
// The card itself uses Kumo, whose hooks cannot render in this pool (see S7), so the
// rendered badge is checked in the browser.
import { describe, expect, it } from "vitest";
import { cardState } from "../src/ui/ToolCard";

describe("tool card state", () => {
  it("shows the live state when the hostname is in the table", () => {
    expect(cardState("add_hostname", "pending", "active")).toEqual({
      state: "active"
    });
  });

  it("labels the state from when the tool ran once the hostname is gone", () => {
    expect(cardState("add_hostname", "pending", undefined)).toEqual({
      state: "pending",
      caption: "when added"
    });
    expect(cardState("get_hostname", "failed", undefined)).toEqual({
      state: "failed",
      caption: "at the time"
    });
  });

  it("shows nothing when neither state is known", () => {
    expect(cardState("add_hostname", undefined, undefined)).toBeNull();
    expect(cardState("add_hostname", "bogus", "also-bogus")).toBeNull();
  });
});
