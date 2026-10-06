// Model text is untrusted. The chat's markdown keeps only https links and never loads
// images. Streamdown's own hooks cannot run in this pool, so the two overrides it uses
// are rendered directly. skipHtml and disallowedElements are checked in the browser.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NoImage, SafeLink } from "../src/ui/Markdown";

const link = (href: string) =>
  renderToStaticMarkup(createElement(SafeLink, { href }, "click"));

describe("chat markdown", () => {
  it("opens https links in a new tab without an opener or referrer", () => {
    const html = link("https://developers.cloudflare.com/");
    expect(html).toContain('href="https://developers.cloudflare.com/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("renders every other link as plain text", () => {
    for (const href of [
      "http://example.com/",
      "javascript:alert(1)",
      "data:text/html,hi",
      "/relative",
      "//evil.example/",
      ""
    ]) {
      expect(link(href)).toBe("<span>click</span>");
    }
  });

  it("renders images as nothing, so no remote host is contacted", () => {
    // Streamdown passes the image's src. The override ignores it and renders nothing.
    expect(renderToStaticMarkup(createElement(NoImage))).toBe("");
  });
});
