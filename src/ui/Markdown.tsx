// Assistant text as sanitized markdown. Raw HTML is skipped, images are never loaded,
// and only https links render as links (new tab, noopener). Anything else is text.
import type { ComponentProps, ReactNode } from "react";
import { Streamdown } from "streamdown";

export function SafeLink({
  href = "",
  children
}: {
  href?: string;
  children?: ReactNode;
}) {
  let safe: string | null = null;
  try {
    const url = new URL(href);
    if (url.protocol === "https:") safe = url.toString();
  } catch {
    safe = null;
  }
  if (!safe) return <span>{children}</span>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      className="underline"
    >
      {children}
    </a>
  );
}

export const NoImage = () => null;

// Streamdown types its overrides loosely, so the two safe components are cast once here.
const COMPONENTS = { a: SafeLink, img: NoImage } as unknown as ComponentProps<
  typeof Streamdown
>["components"];

export function Markdown({
  text,
  animating
}: {
  text: string;
  animating: boolean;
}) {
  return (
    <Streamdown
      className="sd-theme p-3 break-words"
      skipHtml
      // Incomplete-markdown repair treats the "_" in _cf-custom-hostname as an open
      // italic and appends a closing "_". DNS names are everywhere here, so it is off.
      parseIncompleteMarkdown={false}
      disallowedElements={["img", "iframe", "script", "style"]}
      components={COMPONENTS}
      controls={false}
      isAnimating={animating}
    >
      {text}
    </Streamdown>
  );
}
