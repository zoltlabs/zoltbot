import {
  Children,
  type ComponentProps,
  isValidElement,
  memo,
  type ReactNode,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function CodeBlock({ children }: ComponentProps<"pre">) {
  const [copied, setCopied] = useState<string | undefined>();
  const [copyError, setCopyError] = useState(false);
  const code = Children.toArray(children).find((child) => isValidElement(child));
  const props = isValidElement<{ className?: string; children?: ReactNode }>(code)
    ? code.props
    : undefined;
  const value = typeof props?.children === "string" ? props.children : "";
  const language = props?.className?.match(/language-([\w+-]+)/)?.[1] ?? "Code";
  const copy = async (element: HTMLElement) => {
    try {
      await navigator.clipboard.writeText(element.querySelector("code")?.textContent ?? "");
      setCopied(value);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };
  return (
    <div className="chat-code">
      <div className="chat-code-bar">
        <span>{language}</span>
        <button
          type="button"
          className="btn sm"
          onClick={(event) => {
            const root = event.currentTarget.closest<HTMLElement>(".chat-code");
            if (root) void copy(root);
          }}
        >
          {copyError ? "Copy failed, retry" : copied === value ? "Copied" : "Copy code"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}
const components = {
  pre: CodeBlock,
  a: ({ href, children }: ComponentProps<"a">) =>
    href && /^#artifact\/artifact-[a-f0-9]{64}$/.test(href) ? (
      <a href={href}>{children}</a>
    ) : href && /^https?:\/\//i.test(href) ? (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          void window.zoltDesktop?.openExternal?.(href).catch(() => {});
        }}
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }: ComponentProps<"img">) => (
    <span className="dim">{alt ? `Image: ${alt}` : "Image"}</span>
  ),
};
export const Markdown = memo(function Markdown({ value }: { value: string }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {value}
      </ReactMarkdown>
    </div>
  );
});
