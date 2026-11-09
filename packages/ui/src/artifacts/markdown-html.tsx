import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Trusted conversion only; output stays in a scriptless opaque artifact frame. */
export function artifactMarkdownHtml(value: string) {
  return renderToStaticMarkup(
    <article>
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children }) => <span>{children}</span>,
          img: ({ alt }) => <span>{alt ? `Image: ${alt}` : "Image"}</span>,
        }}
      >
        {value}
      </ReactMarkdown>
    </article>,
  );
}
