import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ManuscriptOutlineDescriptorLookupIdentity } from "../../services/manuscriptOutlineParser";
import { buildStructuredOutlinePreviewPresentation } from "../../services/manuscriptStructuredOutlinePreviewPresentation";

export function ManuscriptSegmentPreview({
  markdown,
  descriptorLookupIdentity,
  labels
}: {
  markdown: string;
  descriptorLookupIdentity?: ManuscriptOutlineDescriptorLookupIdentity;
  labels?: Partial<Readonly<{
    empty: string;
    ariaLabel: string;
    image: string;
    structuredOutline: string;
    archiveHint: string;
    emptyValue: string;
  }>>;
}) {
  const productLabels = {
    empty: "当前文稿没有可预览的正文。",
    ariaLabel: "当前分段草稿预览",
    image: "图片",
    structuredOutline: "结构化纲要",
    archiveHint: "此区域作为文稿切换的可读区域，请勿修改格式。",
    emptyValue: "未填写",
    ...labels
  };
  const presentation = descriptorLookupIdentity
    ? buildStructuredOutlinePreviewPresentation({
        rawMarkdown: markdown,
        descriptorLookupIdentity,
        hint: productLabels.archiveHint,
        emptyValue: productLabels.emptyValue
      })
    : {
        bodyMarkdown: markdown,
        sourceMarkdown: markdown,
        sourceMutationCount: 0 as const
      };
  if (!presentation.bodyMarkdown.trim() && !presentation.archive) {
    return (
      <section className="manuscript-segment-preview manuscript-segment-preview--empty" role="status">
        {productLabels.empty}
      </section>
    );
  }
  return (
    <section
      aria-label={productLabels.ariaLabel}
      className="manuscript-segment-preview markdown-body"
      data-preview-authority="current-sidecar-draft"
      data-preview-persistent-body-count="0"
      data-structured-outline-presentation={presentation.archive
        ? "PREVIEW_PRESENTATION_ONLY"
        : "NONE"}
    >
      {presentation.bodyMarkdown.trim() ? (
        <ReactMarkdown
          components={{
            img: ({ alt }) => <span>{alt ? `[${productLabels.image}: ${alt}]` : `[${productLabels.image}]`}</span>,
            a: ({ children, ...props }) => <a {...props} rel="noreferrer noopener">{children}</a>
          }}
          remarkPlugins={[remarkGfm]}
          skipHtml
        >
          {presentation.bodyMarkdown}
        </ReactMarkdown>
      ) : null}
      {presentation.archive ? (
        <aside
          aria-label={productLabels.structuredOutline}
          className="manuscript-structured-outline-preview"
          data-source-mutation-count="0"
        >
          <p className="manuscript-structured-outline-preview__hint">
            {presentation.archive.hint}
          </p>
          <dl>
            {presentation.archive.fields.map((field) => (
              <div key={field.stableKey}>
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
        </aside>
      ) : null}
    </section>
  );
}
