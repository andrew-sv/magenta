"use client";

import "katex/dist/katex.min.css";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

type Props = {
  children: string;
  className?: string;
};

/**
 * Many LLMs emit math using bare parentheses / brackets instead of `$…$` or
 * `$$…$$`. Convert those to KaTeX-compatible delimiters before parsing.
 *
 * Heuristic: a substring is "math-like" if it contains a LaTeX command
 * (`\foo`), a subscript (`_`), or a superscript (`^`). Plain prose like
 * "(see fig. 1)" is left alone. Code blocks (fenced and inline) are skipped
 * entirely so math syntax inside code samples renders verbatim.
 */
const LATEX_HINT = /\\[a-zA-Z]+|[_^]/;

function looksLikeMath(s: string): boolean {
  return LATEX_HINT.test(s);
}

function transformProse(text: string): string {
  // 1. Honor LaTeX escape syntax outright: \[ ... \] and \( ... \).
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, inner: string) => `\n$$${inner.trim()}$$\n`);
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, inner: string) => `$${inner.trim()}$`);

  // 2. Bare [ ... ] -> $$ ... $$ when math-like and NOT a markdown link.
  //    Lookahead `(?!\()` excludes the `[label](url)` shape.
  text = text.replace(
    /(^|[^\\])\[([^\[\]\n]{1,500})\](?!\()/g,
    (full, lead: string, inner: string) =>
      looksLikeMath(inner) ? `${lead}\n$$${inner.trim()}$$\n` : full,
  );

  // 3. Bare ( ... ) -> $ ... $ when math-like. Excludes nested parens, which
  //    is fine since LLM math typically uses braces (\frac{a}{b}, etc.).
  text = text.replace(
    /(^|[^\\])\(([^()\n]{1,500})\)/g,
    (full, lead: string, inner: string) =>
      looksLikeMath(inner) ? `${lead}$${inner.trim()}$` : full,
  );

  return text;
}

function preprocessMath(text: string): string {
  // Split out code segments (fenced blocks and inline `code`) and leave them
  // untouched. Transform only the surrounding prose.
  const codeRe = /(```[\s\S]*?```|`[^`\n]+`)/g;
  let lastIndex = 0;
  let out = "";
  for (const m of text.matchAll(codeRe)) {
    const idx = m.index ?? 0;
    out += transformProse(text.slice(lastIndex, idx));
    out += m[0];
    lastIndex = idx + m[0].length;
  }
  out += transformProse(text.slice(lastIndex));
  return out;
}

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
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: "ignore", output: "html" }]]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
        }}
      >
        {preprocessMath(children)}
      </ReactMarkdown>
    </div>
  );
}
