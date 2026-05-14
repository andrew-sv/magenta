"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  children: string;
  className?: string;
};

/**
 * Renders assistant-side text as Markdown. Constrained `prose` so headings,
 * code blocks, lists, tables, and blockquotes all get sensible spacing without
 * us styling each tag inline.
 *
 * Links open in a new tab and rel="noreferrer" — assistant output can contain
 * arbitrary URLs.
 */
export function Markdown({ children, className }: Props) {
  return (
    <div
      className={[
        "prose prose-sm max-w-none",
        "dark:prose-invert",
        "prose-pre:my-2 prose-pre:rounded-md prose-pre:bg-neutral-100 dark:prose-pre:bg-neutral-800",
        "prose-code:rounded prose-code:bg-neutral-100 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:before:hidden prose-code:after:hidden dark:prose-code:bg-neutral-800",
        "prose-p:my-2 prose-headings:mt-3 prose-headings:mb-2",
        "prose-ul:my-2 prose-ol:my-2 prose-li:my-0",
        "prose-table:my-2",
        className ?? "",
      ].join(" ")}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
