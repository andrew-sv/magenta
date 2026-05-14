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

/**
 * No-argument math commands that should be wrapped in math delimiters even
 * when they don't carry braces or sub/superscripts (e.g. `\alpha`, `\infty`).
 */
const NO_ARG_MATH_COMMANDS = new Set([
  // Greek letters (lowercase + uppercase variants)
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta",
  "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi", "pi",
  "varpi", "rho", "varrho", "sigma", "varsigma", "tau", "upsilon", "phi",
  "varphi", "chi", "psi", "omega",
  "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Phi", "Psi", "Omega",
  // Operators / relations / arrows / symbols (no-arg)
  "cdot", "times", "div", "pm", "mp", "ast", "star", "circ",
  "leq", "geq", "neq", "equiv", "approx", "sim", "simeq", "cong", "propto",
  "infty", "partial", "nabla", "hbar", "ell", "emptyset",
  "in", "notin", "ni", "subset", "supset", "subseteq", "supseteq",
  "cup", "cap", "setminus",
  "forall", "exists", "neg", "lor", "land", "implies", "iff",
  "to", "leftarrow", "rightarrow", "leftrightarrow",
  "Leftarrow", "Rightarrow", "Leftrightarrow", "mapsto",
  "dots", "ldots", "cdots", "vdots", "ddots",
]);

/**
 * Delimiter-sizing commands. Their following `(`, `[`, `\{`, etc. are NOT
 * standalone parens to be treated as math — they're part of an enclosing
 * `\left…\right` pair. We either wrap the whole `\left X … \right Y` as one
 * math span, or pass through verbatim when the matching half is absent.
 */
const DELIMITER_COMMANDS = new Set([
  "left", "right",
  "big", "Big", "bigg", "Bigg",
  "bigl", "bigr", "Bigl", "Bigr",
  "biggl", "biggr", "Biggl", "Biggr",
]);

function looksLikeMath(s: string): boolean {
  return LATEX_HINT.test(s);
}

/**
 * Given that `text[start]` is `\` followed by a command name, return the
 * index one past the last character of that command's full argument tail —
 * balanced `{…}` / `[…]` groups, `_x` / `^x` scripts, and `_{…}` / `^{…}`
 * script groups. Greedy: consumes back-to-back arg groups belonging to the
 * same command.
 */
function expandCommandMatch(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && /[a-zA-Z]/.test(text[i])) i++;
  while (i < text.length) {
    const c = text[i];
    if ((c === " " || c === "\t") && /[{[_^]/.test(text[i + 1] ?? "")) {
      i++;
      continue;
    }
    if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      let depth = 1;
      i++;
      while (i < text.length && depth > 0) {
        if (text[i] === c) depth++;
        else if (text[i] === close) depth--;
        i++;
      }
    } else if (c === "_" || c === "^") {
      i++;
      if (text[i] === "{") {
        let depth = 1;
        i++;
        while (i < text.length && depth > 0) {
          if (text[i] === "{") depth++;
          else if (text[i] === "}") depth--;
          i++;
        }
      } else if (i < text.length) {
        i++;
      }
    } else {
      break;
    }
  }
  return i;
}

/** Skip `\left` or `\right` plus optional whitespace plus one delimiter char. */
function skipDelimiterCmd(text: string, start: number, name: string): number {
  let i = start + 1 + name.length;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  if (i < text.length) {
    if (text[i] === "\\" && i + 1 < text.length) i += 2;
    else i++;
  }
  return i;
}

/** Locate the matching `\right Y` for a `\left X` at `leftStart`. Returns the
 *  index just past the closing delimiter, or -1 if not found on the same line. */
function findMatchingRight(text: string, leftStart: number): number {
  let depth = 1;
  let j = skipDelimiterCmd(text, leftStart, "left");
  while (j < text.length) {
    const c = text[j];
    if (c === "\n") return -1;
    if (c === "\\") {
      if (text.slice(j + 1, j + 6) === "right") {
        const end = skipDelimiterCmd(text, j, "right");
        depth--;
        if (depth === 0) return end;
        j = end;
        continue;
      }
      if (text.slice(j + 1, j + 5) === "left") {
        depth++;
        j = skipDelimiterCmd(text, j, "left");
        continue;
      }
    }
    j++;
  }
  return -1;
}

/** Single-character bracket search on the same line — no nesting tolerated. */
function findSimpleClose(text: string, start: number, open: string, close: string): number {
  for (let j = start + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\n") return -1;
    if (ch === open) return -1;
    if (ch === close) return j;
  }
  return -1;
}

/**
 * Stream through prose, rewriting math-like substrings to KaTeX-compatible
 * delimiters. Done as a single state-machine pass so that existing `$…$` /
 * `$$…$$` blocks and `\left…\right` runs are protected from the bare-paren
 * and bare-bracket rules — separate regex passes would corrupt them.
 */
function transformProse(text: string): string {
  let i = 0;
  let out = "";

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];

    // 1. Existing $$ … $$ block — pass through verbatim.
    if (c === "$" && next === "$") {
      const end = text.indexOf("$$", i + 2);
      if (end !== -1) {
        out += text.slice(i, end + 2);
        i = end + 2;
        continue;
      }
    }
    // 2. Existing single-line $ … $ — pass through verbatim.
    if (c === "$") {
      const end = text.indexOf("$", i + 1);
      if (end !== -1 && !text.slice(i + 1, end).includes("\n")) {
        out += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    // 3. \( … \) — LaTeX escape inline.
    if (c === "\\" && next === "(") {
      const end = text.indexOf("\\)", i + 2);
      if (end !== -1) {
        out += `$${text.slice(i + 2, end).trim()}$`;
        i = end + 2;
        continue;
      }
    }
    // 4. \[ … \] — LaTeX escape display.
    if (c === "\\" && next === "[") {
      const end = text.indexOf("\\]", i + 2);
      if (end !== -1) {
        out += `\n$$${text.slice(i + 2, end).trim()}$$\n`;
        i = end + 2;
        continue;
      }
    }
    // 5. Backslash command — three sub-cases.
    if (c === "\\" && /[a-zA-Z]/.test(next ?? "")) {
      const cmdName = (text.slice(i + 1).match(/^[a-zA-Z]+/) ?? [""])[0];

      // 5a. \left X … \right Y — wrap the whole span as one math block when
      //     we can find the matching \right; otherwise pass through.
      if (DELIMITER_COMMANDS.has(cmdName)) {
        if (cmdName === "left") {
          const rightEnd = findMatchingRight(text, i);
          if (rightEnd !== -1) {
            let span = text.slice(i, rightEnd);
            span = span.replace(/\$([^$\n]+)\$/g, (_, inner: string) => `(${inner})`);
            out += `$${span}$`;
            i = rightEnd;
            continue;
          }
        }
        const passEnd = skipDelimiterCmd(text, i, cmdName);
        out += text.slice(i, passEnd);
        i = passEnd;
        continue;
      }

      // 5b. Bare \command{…} or known no-arg math token — wrap.
      const cmdEnd = i + 1 + cmdName.length;
      let afterWS = cmdEnd;
      while (afterWS < text.length && (text[afterWS] === " " || text[afterWS] === "\t")) afterWS++;
      const hasArgs = /[{[_^]/.test(text[afterWS] ?? "");
      if (hasArgs || NO_ARG_MATH_COMMANDS.has(cmdName)) {
        const end = expandCommandMatch(text, i);
        let span = text.slice(i, end);
        // Mis-emitted `$inner$` inside the math span → parens (the model
        // probably meant parens, not delimiters).
        span = span.replace(/\$([^$\n]+)\$/g, (_, inner: string) => `(${inner})`);
        out += `$${span}$`;
        i = end;
        continue;
      }
      // 5c. Unknown command with no args (e.g. `\n`) — fall through to char emit.
    }

    // 6. Bare [ math ] -> $$ math $$ (single-line, math-like, not a link).
    if (c === "[") {
      const end = findSimpleClose(text, i, "[", "]");
      if (end !== -1 && text[end + 1] !== "(") {
        const inner = text.slice(i + 1, end);
        if (looksLikeMath(inner)) {
          out += `\n$$${inner.trim()}$$\n`;
          i = end + 1;
          continue;
        }
      }
    }
    // 7. Bare ( math ) -> $ math $ (single-line, math-like).
    if (c === "(") {
      const end = findSimpleClose(text, i, "(", ")");
      if (end !== -1) {
        const inner = text.slice(i + 1, end);
        if (looksLikeMath(inner)) {
          out += `$${inner.trim()}$`;
          i = end + 1;
          continue;
        }
      }
    }

    out += c;
    i++;
  }

  return out;
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
