# Parsing Feature

## Scope

**In scope:**
- Tree-sitter based source code parsing for Python, TypeScript, JavaScript, and Rust
- Extraction of code blocks (functions, classes, structs, enums, traits, interfaces, impls, modules, constants, type aliases)
- Decorator references (Python)
- Visibility detection for code symbols
- Collection of raw references (imports, function calls, method calls, type references, inheritance, trait implementations)
- Language-specific classification via the `LanguageSupport` trait
- Extension probing for import resolution

**Not in scope:**
- Full name resolution or semantic analysis
- Type inference
- Cross-file reference resolution (handled by resolver subsystem)
- Language-specific formatting or pretty-printing
- Mapping a *module* alias back to its module (`import numpy as np`; a later
  `np.array()` still resolves by the bare name `array`). Only `from x import y as z`
  *symbol* bindings are recorded.
- Resolving `self.helper()` to the enclosing class rather than by bare method name
- Python string forward references in annotations (`x: "Fwd"`)

## Data/Control Flow

1. `Extractor::extract_file(file_path, source, language)` is the entry point.
2. A `LanguageSupport` implementation is selected based on the `Language` enum.
3. A tree-sitter parser is initialized with the appropriate grammar from the language support implementation.
4. The source is parsed into a tree-sitter syntax tree.
5. `walk_tree()` performs a single traversal of the entire file tree, visiting every node exactly once. It carries an `attribution_id` that starts as the File `NodeId`:
   - At each node, `lang.classify_node()` determines if the node represents a code block.
   - If classified, a `CodeNode::CodeBlock` is created (its `parent` is the current attribution id) and the attribution id switches to the new block id for this node and its subtree.
   - `lang.collect_node_references()` is then called on the current node exactly once, attributing any raw references to the current (possibly just-updated) attribution id. This means references land on the innermost enclosing block, top-level imports/refs land on the File, and a block node that also emits a reference (e.g. a Rust `impl_item` emitting a `TraitImpl`) attributes it to itself.
   - Children are recursed with the current attribution id.
6. A post-pass (`link_block_children()`) populates each block's `children` vec from the `parent` links: every block whose parent is another block in the same file is pushed into that parent's children. Blocks parented directly to the File are left for the caller.
7. Returns `(Vec<CodeNode>, Vec<RawReference>)`. In `parse_repo`, only blocks whose parent is the File node are appended to the File node's children; `parse_repo` also strips prior parse state up front (removing CodeBlock nodes, clearing block ids from File children, clearing edges, and rebuilding adjacency) so re-parsing the same repo is idempotent.

## Architecture

The parser uses a trait-based system to separate language-specific logic from the shared extraction framework.

### LanguageSupport Trait (`parser/language.rs`)
Defines the interface every language must implement:
- `classify_node()` - Determine if a tree-sitter node is a code block
- `collect_node_references()` - Collect raw references from a single node (the extractor drives the walk and calls this once per node)
- `tree_sitter_language()` - Return the tree-sitter grammar

### Language Implementations
- `PythonSupport` (`parser/python.rs`) - Python functions, classes, module-level constants/type aliases, imports, calls, decorators, type annotations, inheritance. See "Python extraction rules" below.
- `TypeScriptSupport` / `JavaScriptSupport` (`parser/typescript.rs`) - TS/JS functions, classes, interfaces, type aliases, enums, arrow functions, imports, calls, type refs, inheritance
- `RustSupport` (`parser/rust_lang.rs`) - Rust functions, structs, enums, traits, impls, modules, constants, type aliases, use declarations, calls, type refs, trait impls. Includes improved visibility detection for `pub`, `pub(crate)`, and `pub(super)`. Use declarations expand to full module paths (`expand_use_paths`): use lists yield one Import ref per leaf, aliases resolve to the original path, `self` maps to the module, wildcards import the module itself.

### Python extraction rules (`parser/python.rs`)

Every rule below inspects a single tree-sitter node plus (at most) that node's own
parent chain and direct children. Nothing recurses into a subtree, so each raw
reference is attributed to exactly one node.

**Blocks (`classify_node`)**

| Node kind | Block | Notes |
|---|---|---|
| `function_definition` | `Function` | |
| `class_definition` | `Class` | |
| `assignment` | `Constant` / `TypeAlias` | module-level, single-identifier target only |
| `type_alias_statement` | `TypeAlias` | PEP 695 `type X = Y` / `type G[T] = ...` |

PEP 695 `type_alias_statement` is unambiguously a type declaration, so unlike
`NAME = ...` bindings it is classified wherever it appears. The block name comes
from the `left:` field (its `identifier`, or the base `identifier` of a
`generic_type` for `type G[T] = ...`).

Module-level bindings are deliberately narrow to keep the graph from exploding:
the `assignment` must sit directly in the module body (`module > expression_statement >
assignment`) and bind a single plain `identifier`. Class-body fields, function
locals, tuple unpacking (`a, b = ...`), and subscript/attribute targets
(`REGISTRY['a'] = ...`, `obj.attr = ...`) never become nodes. A binding is
`TypeAlias` when annotated `: TypeAlias` or initialized from
`TypeVar` / `NewType` / `ParamSpec` / `TypeVarTuple`; otherwise `Constant`.

**Visibility (`python_visibility`)** — `__dunder__` (leading and trailing double
underscore, length > 4) is `Public` because it is part of the public protocol;
`__mangled` (leading double underscore, no trailing dunder) and `_internal` are
`Private`; everything else is `Public`. Applied to functions, classes, and
module-level bindings alike.

**Imports** — `RawRefKind::Import { module_path }` is the clean dotted module path
exactly as written in source, with the `as` alias clause stripped and imported
symbol names excluded. One ref per imported module. `RawReference::name` equals
`module_path`. This is the contract the import resolver consumes:

| Source | `module_path` |
|---|---|
| `import os, sys` | `os`, `sys` (two refs) |
| `import numpy as np` | `numpy` |
| `import a.b.c` | `a.b.c` |
| `from mypkg.mod import Thing, other` | `mypkg.mod` |
| `from .rel import X as Y` | `.rel` |
| `from . import x` | `.` |
| `from ..pkg.sub import y` | `..pkg.sub` |
| `from pkg.mod import *` | `pkg.mod` |

`import_statement` iterates every `name:` field (so multi-name imports are not
dropped) and unwraps `aliased_import` to its `name:` child. `import_from_statement`
reads only `module_name:`, whose text is already correct for both `dotted_name` and
`relative_import` (leading dots preserved). `future_import_statement`
(`from __future__ import ...`) emits nothing.

**Imported-symbol bindings** — `import_from_statement` *additionally* emits one
`RawRefKind::ImportedSymbol { module_path, original, local }` per imported name.
`module_path` is identical to the statement's `Import` ref; `original` is the
name as defined in the imported module and `local` is the name bound in this
file (they differ only under an `as` rename). `RawReference::name` carries
`local`.

| Source | bindings |
|---|---|
| `from mypkg.mod import Thing, other` | `(mypkg.mod, Thing, Thing)`, `(mypkg.mod, other, other)` |
| `from mypkg.mod import Thing as T` | `(mypkg.mod, Thing, T)` |
| `from . import x` | `(., x, x)` |
| `from pkg.mod import *` | none (`wildcard_import` has no `name:` field) |
| `import numpy as np` | none (binds a *module*, not a symbol) |
| `from __future__ import annotations` | none |

**This variant deliberately produces no edge.** It is resolution context, not a
reference: the module already has its own `Import` ref (and therefore its own
Import edge), so turning every imported name into an edge would multiply
symbol-edge volume without adding information. `ImportResolver::resolve` matches
only `Import { .. }` and ignores it; `SymbolTable::resolve_references` folds the
bindings into a per-file `local -> (module_path, original)` map and uses it as a
precision tier (see `docs/features/resolution_precision.md`).

**Type annotations** — only leaf names are emitted; the raw text of a composite
annotation is never used. Each annotation node kind contributes its own leaf and
lets the walk reach the rest:
- `type` emits its child when the child is an `identifier` or `attribute` (last segment).
- `generic_type` emits its base name only (`MyGeneric[Inner]` -> `MyGeneric`); the
  parameters are nested `type` nodes visited separately.
- `binary_operator` emits its `left`/`right` leaf operands, but only when an
  ancestor walk through nested `binary_operator`s lands on a `type` node. Nested
  operands that are themselves `binary_operator`s are visited on their own.

Names matching `is_python_builtin_type` or `is_typing_construct` (`Optional`,
`List`, `Dict`, `Union`, `Any`, `Callable`, `Protocol`, ...) are dropped. Result:
`list[MyClass]` yields exactly one `TypeReference` named `MyClass`. String forward
references (`x: "Fwd"`) are not resolved.

The `left:` side of a PEP 695 `type X[T] = ...` statement is skipped
(`is_type_alias_declaration`, an ancestor walk): in the grammar the alias name
and its parameter list are themselves `type` / `generic_type` nodes, so without
the guard the alias block would emit a `TypeReference` to itself and to its own
type parameters. The `right:` side behaves normally.

**Inheritance** — an `argument_list` whose parent is a `class_definition` emits one
`Inheritance` ref per base: `identifier` and `attribute` (last segment) directly,
`subscript` via its `value:` field (`Generic[T]` -> `Generic`), and
`keyword_argument` via its `value:` field (`metaclass=Meta` -> `Meta`). Base names
are not filtered against the builtin/typing lists.

**Decorators** — a `decorator` node whose child is an `identifier` emits a
`FunctionCall` ref, and whose child is an `attribute` emits a `MethodCall` ref for
the last segment. Call-form decorators (`@app.route("/x")`) wrap a `call` node that
the `call` arm already handles, so the `decorator` arm skips them; there is no
double-counting. Decorators sit above the definition inside `decorated_definition`,
so their refs attribute to the enclosing scope, not the decorated block.

### Shared Framework (`parser/extract.rs`)
- `Extractor` struct with `extract_file()` public API (unchanged from original)
- Helper functions: `child_text()`, `extract_signature()`, `node_span()`, `extract_function_name()` (all `pub(crate)`)
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
- The tree is walked exactly once; `collect_node_references()` is called once per node and must inspect only the given node (it may look at the node's own parent/children, e.g. Python's `argument_list` inheritance check or TS's `extends_clause`, but must not recurse the subtree — the extractor drives descent).
- Each raw reference is attributed to exactly one node: the innermost enclosing block, or the File for top-level constructs. There is no double-counting across a block and its ancestors.
- Every block's `children` vec lists exactly its direct child blocks (blocks whose `parent` equals that block); the File node's children list only top-level blocks (parent == File).
- `parse_repo` is idempotent: it strips all CodeBlock nodes, block ids from File children, and edges before re-parsing.
- The `Visibility` enum reuses `Protected` for Rust's `pub(super)` and `Crate` for `pub(crate)`.
- Python `RawRefKind::Import { module_path }` is always a clean dotted path as
  written in source (no alias clause, no imported symbol names), one ref per
  module. The import resolver depends on this exact shape.
- `RawRefKind::ImportedSymbol` never yields an edge, in any resolver. Its
  `module_path` has exactly the same shape as `Import { module_path }`. Adding
  bindings must never change symbol-edge *volume*, only edge *targets*.
- Python module-level bindings only become blocks when the assignment is a direct
  child of the module body and binds a single identifier; nothing inside a class
  body or function body is ever classified.
