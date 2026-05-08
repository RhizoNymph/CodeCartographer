import type { CodeNode } from "../api/types";

/**
 * Returns a single-character (or emoji) icon representing the node type/kind.
 * Shared across Sidebar, DetailsPanel, Breadcrumbs, etc.
 */
export function getIcon(node: CodeNode): string {
  switch (node.type) {
    case "Directory":
      return "\u{1F4C1}";
    case "File":
      return "\u{1F4C4}";
    case "CodeBlock":
      switch (node.kind) {
        case "Function": return "ƒ";
        case "Class": return "C";
        case "Struct": return "S";
        case "Enum": return "E";
        case "Trait": return "T";
        case "Interface": return "I";
        case "Impl": return "⇒";
        case "Module": return "M";
        case "Constant": return "K";
        case "TypeAlias": return "≡";
        default: return "•";
      }
  }
}
