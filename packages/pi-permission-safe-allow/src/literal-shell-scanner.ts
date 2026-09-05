export interface LiteralShellChain {
  leaves: string[];
  certain: boolean;
}

const CONTROL_STRUCTURE = /^(?:if|then|elif|else|fi|for|while|until|case|esac|select|do|done|function|\{|\})(?:\s|$)/;

/**
 * Split a literal shell chain on unquoted `;`, `&&`, and `||` separators.
 * Strict mode rejects syntax whose execution cannot be represented faithfully as
 * a flat chain, so UI callers do not make semantic claims about complex input.
 */
export function scanLiteralShellChain(
  command: string,
  options: { rejectComplexSyntax?: boolean } = {},
): LiteralShellChain {
  const leaves: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let complex = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = quote === character ? undefined : quote ?? character;
      continue;
    }
    if (quote) continue;

    const pair = command.slice(index, index + 2);
    const separatorLength = character === ";" ? 1 : pair === "&&" || pair === "||" ? 2 : 0;
    if (separatorLength) {
      const leaf = command.slice(start, index).trim();
      if (!leaf) return { leaves: [], certain: false };
      leaves.push(leaf);
      index += separatorLength - 1;
      start = index + 1;
      continue;
    }

    if (
      options.rejectComplexSyntax &&
      (character === "\n" ||
        character === "\r" ||
        character === "`" ||
        character === "$" ||
        character === "(" ||
        character === ")" ||
        character === "<" ||
        character === ">" ||
        character === "|" ||
        character === "&")
    ) {
      complex = true;
    }
  }

  const leaf = command.slice(start).trim();
  if (quote || escaped || !leaf) return { leaves: [], certain: false };
  leaves.push(leaf);

  if (
    options.rejectComplexSyntax &&
    (complex || leaves.some((part) => CONTROL_STRUCTURE.test(part.trim())))
  ) {
    return { leaves: [], certain: false };
  }
  return { leaves, certain: true };
}
