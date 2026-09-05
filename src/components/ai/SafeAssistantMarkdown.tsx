import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TextMessagePartComponent } from "@assistant-ui/react";

function safeExternalHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function SafeMarkdownBody({ text }: { text: string }) {
  return (
    <div className="global-ai-chat-panel__markdown" data-ai-safe-markdown="true">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => safeExternalHttpUrl(url) ?? ""}
        components={{
          a: ({ href, children }) => {
            const safeHref = safeExternalHttpUrl(href);
            return safeHref ? (
              <a href={safeHref} rel="noopener noreferrer" target="_blank">
                {children}
              </a>
            ) : <span>{children}</span>;
          },
          img: ({ alt }) => (
            <span className="global-ai-chat-panel__markdown-image-blocked">
              [image blocked{alt ? `: ${alt}` : ""}]
            </span>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function SafeAssistantMarkdown({ text }: { text: string }) {
  return <SafeMarkdownBody text={text} />;
}

export const AssistantMarkdownPart: TextMessagePartComponent = ({ text }) => (
  <SafeAssistantMarkdown text={text} />
);
