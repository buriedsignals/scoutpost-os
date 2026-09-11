/** Inline syntax shared by the email renderer and its citation guard. */
import { Lexer, type Token } from "npm:marked@17.0.5";

export function emailInlineTokens(text: string): Token[] {
  // Emails support explicit inline links, not automatic linking of bare URLs.
  return Lexer.lexInline(text, { gfm: false });
}

export function emailLinkedUrls(text: string): string[] {
  const urls: string[] = [];
  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === "link") urls.push(token.href);
      // The renderer interprets strong content recursively; other constructs
      // (images, raw HTML, code, etc.) are emitted as escaped literal text.
      if (token.type === "strong") visit(token.tokens ?? []);
    }
  };
  for (const line of text.split("\n")) visit(emailInlineTokens(line));
  return urls;
}

/** Prevent source-controlled text from acquiring Markdown meaning on render. */
export function escapeDigestText(text: string): string {
  return text.replace(/[\\`*_[\]()<>]/g, "\\$&");
}
