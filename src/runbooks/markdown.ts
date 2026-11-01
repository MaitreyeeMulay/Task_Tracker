// A deliberately small Markdown reader for runbooks. It returns plain-text
// blocks that React renders as text, never as HTML, so a runbook cannot inject
// markup or scripts (no dangerouslySetInnerHTML, no HTML parser dependency).
// Supported: # headings (1-3), paragraphs, - / * lists, ``` code, - [ ] steps.

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "step"; index: number; text: string }
  | { type: "code"; text: string };

const MAX_STEPS = 100;
const HEADING = /^(#{1,3})\s+(.*)$/;
const STEP = /^[-*]\s+\[[ xX]\]\s*(.*)$/;
const LIST_ITEM = /^[-*]\s+(.*)$/;

export function parseRunbook(markdown: string): { blocks: Block[]; steps: string[] } {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  const steps: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    if (list.length) blocks.push({ type: "list", items: list });
    paragraph = [];
    list = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trimEnd();
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !(lines[i] ?? "").trim().startsWith("```"); i++) code.push((lines[i] ?? "").trimEnd());
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    if (trimmed === "") {
      flush();
      continue;
    }

    const heading = HEADING.exec(trimmed);
    if (heading?.[1] && heading[2] !== undefined) {
      flush();
      blocks.push({ type: "heading", level: heading[1].length as 1 | 2 | 3, text: heading[2].trim() });
      continue;
    }

    const step = STEP.exec(trimmed);
    if (step) {
      flush();
      const text = (step[1] ?? "").trim();
      if (text && steps.length < MAX_STEPS) {
        blocks.push({ type: "step", index: steps.length, text });
        steps.push(text);
      }
      continue;
    }

    const item = LIST_ITEM.exec(trimmed);
    if (item) {
      if (paragraph.length) flush();
      list.push((item[1] ?? "").trim());
      continue;
    }

    if (list.length) flush();
    paragraph.push(trimmed);
  }
  flush();
  return { blocks, steps };
}
