import type { ReactNode } from "react";
import { openExternalUrl } from "../lib/amaroAuth";

type Block =
  | { type: "p"; lines: string[] }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "h3"; text: string };

function parseBlocks(source: string): Block[] {
  const lines = String(source ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let ul: string[] = [];
  let ol: string[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: "p", lines: [...para] });
      para = [];
    }
  };
  const flushUl = () => {
    if (ul.length) {
      blocks.push({ type: "ul", items: [...ul] });
      ul = [];
    }
  };
  const flushOl = () => {
    if (ol.length) {
      blocks.push({ type: "ol", items: [...ol] });
      ol = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushUl();
    flushOl();
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushAll();
      continue;
    }
    const h3 = /^###\s+(.+)$/.exec(trimmed);
    if (h3) {
      flushAll();
      blocks.push({ type: "h3", text: h3[1] });
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      flushPara();
      flushOl();
      ul.push(trimmed.replace(/^[-*]\s+/, ""));
      continue;
    }
    const num = /^(\d+)\.\s+(.+)$/.exec(trimmed);
    if (num) {
      flushPara();
      flushUl();
      ol.push(num[2]);
      continue;
    }
    flushUl();
    flushOl();
    para.push(trimmed);
  }
  flushAll();
  return blocks.length ? blocks : [{ type: "p", lines: [""] }];
}

function parseInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < text.length) {
    const link = text.slice(i).match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (link && link.index === 0) {
      const [, label, url] = link;
      const href = url.trim();
      if (/^https?:\/\//i.test(href)) {
        nodes.push(
          <button
            key={`${keyPrefix}-a-${k++}`}
            type="button"
            className="rich-text__link"
            onClick={() => void openExternalUrl(href)}
          >
            {label}
          </button>,
        );
      } else {
        nodes.push(label);
      }
      i += link[0].length;
      continue;
    }

    const code = text.slice(i).match(/^`([^`]+)`/);
    if (code && code.index === 0) {
      nodes.push(<code key={`${keyPrefix}-c-${k++}`} className="rich-text__code">{code[1]}</code>);
      i += code[0].length;
      continue;
    }

    const bold = text.slice(i).match(/^\*\*([^*]+)\*\*/);
    if (bold && bold.index === 0) {
      nodes.push(<strong key={`${keyPrefix}-b-${k++}`}>{bold[1]}</strong>);
      i += bold[0].length;
      continue;
    }

    const italic = text.slice(i).match(/^\*([^*]+)\*/);
    if (italic && italic.index === 0) {
      nodes.push(<em key={`${keyPrefix}-i-${k++}`}>{italic[1]}</em>);
      i += italic[0].length;
      continue;
    }

    const nextSpecial = text.slice(i).search(/[\[*`]/);
    const end = nextSpecial < 0 ? text.length : i + nextSpecial;
    if (end > i) {
      nodes.push(text.slice(i, end));
      i = end;
    } else {
      nodes.push(text[i]);
      i += 1;
    }
  }

  return nodes;
}

interface RichTextProps {
  text: string;
  className?: string;
}

export function RichText({ text, className }: RichTextProps) {
  const blocks = parseBlocks(text);
  return (
    <div className={className ? `rich-text ${className}` : "rich-text"}>
      {blocks.map((block, bi) => {
        if (block.type === "h3") {
          return <h3 key={bi} className="rich-text__h3">{parseInline(block.text, `h${bi}`)}</h3>;
        }
        if (block.type === "ul") {
          return (
            <ul key={bi} className="rich-text__ul">
              {block.items.map((item, ii) => (
                <li key={ii}>{parseInline(item, `u${bi}-${ii}`)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "ol") {
          return (
            <ol key={bi} className="rich-text__ol">
              {block.items.map((item, ii) => (
                <li key={ii}>{parseInline(item, `o${bi}-${ii}`)}</li>
              ))}
            </ol>
          );
        }
        return (
          <p key={bi} className="rich-text__p">
            {block.lines.map((line, li) => (
              <span key={li}>
                {li > 0 && <br />}
                {parseInline(line, `p${bi}-${li}`)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
