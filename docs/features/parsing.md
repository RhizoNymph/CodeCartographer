# Parsing Feature

## Scope

**In scope:**
- Tree-sitter based source code parsing for Python, TypeScript, JavaScript, and Rust
- Extraction of code blocks (functions, classes, structs, enums, traits, interfaces, impls, modules, constants, type aliases)
- Visibility detection for code symbols
- Collection of raw references (imports, function calls, method calls, type references, inheritance, trait implementations)
- Language-specific classification via the `LanguageSupport` trait
- Extension probing for import resolution

**Not in scope:**
- Full name resolution or semantic analysis
- Type inference
- Cross-file reference resolution (handled by resolver subsystem)
- Language-specific formatting or pretty-printing

## Data/Control Flow

1. `Extractor::extract_file(file_path, source, language)` is the entry point.
2. A `LanguageSupport` implementation is selected based on the `Language` enum.
3. A tree-sitter parser is initialized with the appropriate grammar from the language support implementation.
4. The source is parsed into a tree-sitter syntax tree.
5. `walk_tree()` recursively traverses the tree:
   - At each node, `lang.classify_node()` determines if the node represents a code block.
   - If classified, a `CodeNode::CodeBlock` is created and `lang.collect_references()` collects raw references from the subtree.
   - Children are recursed with the code block as parent, maintaining the parent-child hierarchy.
6. Returns `(Vec<CodeNode>, Vec<RawReference>)`.

## Architecture

The parser uses a trait-based system to separate language-specific logic from the shared extraction framework.

### LanguageSupport Trait (`parser/language.rs`)
Defines the interface every language must implement:
- `classify_node()` - Determine if a tree-sitter node is a code block
- `collect_references()` - Collect raw references from a subtree
- `tree_sitter_language()` - Return the tree-sitter grammar

### Language Implementations
- `PythonSupport` (`parser/python.rs`) - Python functions, classes, imports, calls, type annotations, inheritance
- `TypeScriptSupport` / `JavaScriptSupport` (`parser/typescript.rs`) - TS/JS functions, classes, interfaces, type aliases, enums, arrow functions, imports, calls, type refs, inheritance
- `RustSupport` (`parser/rust_lang.rs`) - Rust functions, structs, enums, traits, impls, modules, constants, type aliases, use declarations, calls, type refs, trait impls. Includes improved visibility detection for `pub`, `pub(crate)`, and `pub(super)`.

### Shared Framework (`parser/extract.rs`)
- `Extractor` struct with `extract_file()` public API (unchanged from original)
- Helper functions: `child_text()`, `extract_signature()`, `node_span()`, `extract_function_name()`, `extract_use_name()` (all `pub(crate)`)
- Data types: `RawReference`, `RawRefKind`, `ParseEvent`

### Extension Probing (`resolver/extension_probe.rs`)
Consolidates extension probing logic used by the import resolver:
- `probe_path(base, language, path_map)` - Probe with language-specific extensions
- `probe_path_all(base, path_map)` - Probe with all known extensions

## Files

| File | Purpose | Key Exports |
|------|---------|-------------|
| `crates/cc-core/src/parser/mod.rs` | Module declarations | Re-exports from `extract` |
| `crates/cc-core/src/parser/extract.rs` | Shared extraction framework | `Extractor`, `RawReference`, `RawRefKind`, `ParseEvent` |
| `crates/cc-core/src/parser/language.rs` | Trait definition | `LanguageSupport` |
| `crates/cc-core/src/parser/python.rs` | Python support | `PythonSupport` |
| `crates/cc-core/src/parser/typescript.rs` | TS/JS support | `TypeScriptSupport`, `JavaScriptSupport` |
| `crates/cc-core/src/parser/rust_lang.rs` | Rust support | `RustSupport` |
| `crates/cc-core/src/resolver/extension_probe.rs` | Extension probing | `probe_path`, `probe_path_all` |
| `crates/cc-core/src/resolver/import_resolver.rs` | Import resolution | `ImportResolver` |
| `crates/cc-core/src/model/node.rs` | Data model types | `BlockKind`, `Visibility`, `Language`, `NodeId`, `Span` |

## Invariants and Constraints

- The public API of `Extractor::extract_file()` must not change (same signature, same return type).
- Helper functions in `extract.rs` are `pub(crate)` so language modules can use them.
- `collect_references()` only runs on subtrees of classified code blocks, so top-level imports/uses produce no raw references.
- The `Visibility` enum reuses `Protected` for Rust's `pub(super)` and `Crate` for `pub(crate)`.
- Each `LanguageSupport` implementation must handle all stack-based traversal internally (no recursive tree-sitter cursor sharing).
