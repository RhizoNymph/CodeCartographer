use tree_sitter::Node;

use crate::model::{BlockKind, NodeId, Visibility};

use super::extract::Extractor;
use super::extract::{RawRefKind, RawReference};
use super::language::LanguageSupport;

/// Python language support for code classification and reference collection.
pub struct PythonSupport;

impl LanguageSupport for PythonSupport {
    fn classify_node(
        &self,
        kind: &str,
        node: &Node,
        source: &str,
    ) -> Option<(BlockKind, String, Option<Visibility>)> {
        match kind {
            "function_definition" => {
                let name = Extractor::child_text(node, "name", source)?;
                let vis = python_visibility(&name);
                Some((BlockKind::Function, name, Some(vis)))
            }
            "class_definition" => {
                let name = Extractor::child_text(node, "name", source)?;
                let vis = python_visibility(&name);
                Some((BlockKind::Class, name, Some(vis)))
            }
            "assignment" => classify_module_level_assignment(node, source),
            _ => None,
        }
    }

    fn collect_node_references(
        &self,
        source: &str,
        node: &Node,
        from_id: &NodeId,
        refs: &mut Vec<RawReference>,
    ) {
        let current = *node;
        match current.kind() {
            "import_statement" => collect_plain_imports(source, &current, from_id, refs),
            "import_from_statement" => collect_from_import(source, &current, from_id, refs),
            "call" => collect_call(source, &current, from_id, refs),
            "decorator" => collect_decorator(source, &current, from_id, refs),
            "type" => collect_type_annotation(source, &current, from_id, refs),
            "generic_type" => collect_generic_base(source, &current, from_id, refs),
            "binary_operator" => collect_union_type(source, &current, from_id, refs),
            "argument_list" => collect_superclasses(source, &current, from_id, refs),
            _ => {}
        }
    }

    fn tree_sitter_language(&self) -> tree_sitter::Language {
        tree_sitter_python::LANGUAGE.into()
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn node_text(node: &Node, source: &str) -> Option<String> {
    node.utf8_text(source.as_bytes()).ok().map(str::to_string)
}

/// Resolve a name expression to the single identifier a symbol lookup can match:
/// a bare `identifier` yields itself, an `attribute` (`pkg.mod.Thing`) yields its
/// final segment. Anything else has no usable name.
fn leaf_name(node: &Node, source: &str) -> Option<String> {
    match node.kind() {
        "identifier" => node_text(node, source),
        "attribute" => node
            .child_by_field_name("attribute")
            .and_then(|n| node_text(&n, source)),
        _ => None,
    }
}

fn push_ref(
    refs: &mut Vec<RawReference>,
    from_id: &NodeId,
    kind: RawRefKind,
    name: String,
    span_node: &Node,
) {
    if name.is_empty() {
        return;
    }
    refs.push(RawReference {
        from_node: from_id.clone(),
        kind,
        name,
        span: Extractor::node_span(span_node),
    });
}

/// Python visibility convention:
/// - `__dunder__` names are part of the public protocol -> Public
/// - `__mangled` (leading double underscore, no trailing dunder) -> Private
/// - `_internal` (single leading underscore) -> Private
/// - everything else -> Public
fn python_visibility(name: &str) -> Visibility {
    if name.len() > 4 && name.starts_with("__") && name.ends_with("__") {
        Visibility::Public
    } else if name.starts_with('_') {
        Visibility::Private
    } else {
        Visibility::Public
    }
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/// `import a, b.c, numpy as np` -> one Import ref per name, alias clause stripped.
fn collect_plain_imports(
    source: &str,
    node: &Node,
    from_id: &NodeId,
    refs: &mut Vec<RawReference>,
) {
    let mut cursor = node.walk();
    for name_node in node.children_by_field_name("name", &mut cursor) {
        let module = match name_node.kind() {
            "dotted_name" => Some(name_node),
            // `numpy as np` -> keep only the `name:` (dotted) part.
            "aliased_import" => name_node.child_by_field_name("name"),
            _ => None,
        };
        let Some(module) = module else { continue };
        let Some(path) = node_text(&module, source) else {
            continue;
        };
        push_ref(
            refs,
            from_id,
            RawRefKind::Import {
                module_path: path.clone(),
            },
            path,
            &name_node,
        );
    }
}

/// `from pkg.mod import A, B as C` -> exactly one Import ref for `pkg.mod`
/// (the contract the import resolver consumes), plus one edge-free
/// `ImportedSymbol` binding per imported name so the symbol resolver knows
/// where each local name came from.
///
/// Relative imports keep their leading dots (`.`, `.rel`, `..pkg.sub`) because
/// the resolver needs them to walk up from the importing file's package.
fn collect_from_import(source: &str, node: &Node, from_id: &NodeId, refs: &mut Vec<RawReference>) {
    let Some(module) = node.child_by_field_name("module_name") else {
        return;
    };
    // Both `dotted_name` and `relative_import` render to exactly the module
    // path as written in source.
    let Some(path) = node_text(&module, source) else {
        return;
    };
    push_ref(
        refs,
        from_id,
        RawRefKind::Import {
            module_path: path.clone(),
        },
        path.clone(),
        &module,
    );

    collect_imported_symbol_bindings(source, node, from_id, refs, &path);
}

/// One `ImportedSymbol` binding per name in `from <module> import <names>`.
/// `from ... import *` has no `name:` field and therefore binds nothing.
fn collect_imported_symbol_bindings(
    source: &str,
    node: &Node,
    from_id: &NodeId,
    refs: &mut Vec<RawReference>,
    module_path: &str,
) {
    let mut cursor = node.walk();
    for name_node in node.children_by_field_name("name", &mut cursor) {
        let (original_node, local_node) = match name_node.kind() {
            "dotted_name" => (name_node, name_node),
            // `other as o` -> original `other`, local `o`.
            "aliased_import" => {
                let Some(original) = name_node.child_by_field_name("name") else {
                    continue;
                };
                let Some(alias) = name_node.child_by_field_name("alias") else {
                    continue;
                };
                (original, alias)
            }
            _ => continue,
        };
        // `from pkg import a.b` is not legal Python, but a dotted_name still
        // renders its last segment as the bound name.
        let Some(original) = last_dotted_segment(&original_node, source) else {
            continue;
        };
        let Some(local) = last_dotted_segment(&local_node, source) else {
            continue;
        };
        push_ref(
            refs,
            from_id,
            RawRefKind::ImportedSymbol {
                module_path: module_path.to_string(),
                original,
                local: local.clone(),
            },
            local,
            &name_node,
        );
    }
}

/// Last segment of a `dotted_name` / `identifier` node.
fn last_dotted_segment(node: &Node, source: &str) -> Option<String> {
    let text = node_text(node, source)?;
    let segment = text.rsplit('.').next().unwrap_or(&text).trim().to_string();
    if segment.is_empty() {
        None
    } else {
        Some(segment)
    }
}

// ---------------------------------------------------------------------------
// Calls and decorators
// ---------------------------------------------------------------------------

fn collect_call(source: &str, node: &Node, from_id: &NodeId, refs: &mut Vec<RawReference>) {
    let Some(func) = node.child_by_field_name("function") else {
        return;
    };
    let kind = if func.kind() == "attribute" {
        RawRefKind::MethodCall
    } else {
        RawRefKind::FunctionCall
    };
    let name = Extractor::extract_function_name(&func, source);
    push_ref(refs, from_id, kind, name, node);
}

/// Bare decorators (`@my_decorator`, `@mod.cached`). Call-form decorators
/// (`@app.route("/x")`) wrap a `call` node which the `call` arm already handles,
/// so they are skipped here to avoid double-counting.
fn collect_decorator(source: &str, node: &Node, from_id: &NodeId, refs: &mut Vec<RawReference>) {
    let Some(target) = node.named_child(0) else {
        return;
    };
    let kind = match target.kind() {
        "identifier" => RawRefKind::FunctionCall,
        "attribute" => RawRefKind::MethodCall,
        // `call` (and anything else) is handled where it is visited.
        _ => return,
    };
    let Some(name) = leaf_name(&target, source) else {
        return;
    };
    push_ref(refs, from_id, kind, name, &target);
}

// ---------------------------------------------------------------------------
// Type annotations
// ---------------------------------------------------------------------------

/// A `type` node wrapping a plain name: `x: MyClass` or `x: mod.MyClass`.
/// Composite forms (`generic_type`, `binary_operator`, string forward refs)
/// are handled by their own arms as the walk reaches them, so a nested
/// annotation contributes each leaf name exactly once.
fn collect_type_annotation(
    source: &str,
    node: &Node,
    from_id: &NodeId,
    refs: &mut Vec<RawReference>,
) {
    let Some(inner) = node.named_child(0) else {
        return;
    };
    if let Some(name) = leaf_name(&inner, source) {
        emit_type_reference(refs, from_id, name, &inner);
    }
}

/// The base of a generic annotation: `MyGeneric[Inner]` -> `MyGeneric`. The
/// parameters are `type` nodes visited separately.
fn collect_generic_base(source: &str, node: &Node, from_id: &NodeId, refs: &mut Vec<RawReference>) {
    let Some(base) = node.named_child(0) else {
        return;
    };
    if let Some(name) = leaf_name(&base, source) {
        emit_type_reference(refs, from_id, name, &base);
    }
}

/// PEP 604 unions (`A | B | C`) parse as nested `binary_operator`s inside a
/// `type`. Emit only this operator's own leaf operands; nested operators are
/// visited on their own.
fn collect_union_type(source: &str, node: &Node, from_id: &NodeId, refs: &mut Vec<RawReference>) {
    if !is_in_type_position(node) {
        return;
    }
    for field in ["left", "right"] {
        let Some(operand) = node.child_by_field_name(field) else {
            continue;
        };
        if let Some(name) = leaf_name(&operand, source) {
            emit_type_reference(refs, from_id, name, &operand);
        }
    }
}

/// True when this `binary_operator` sits inside a `type` annotation, possibly
/// nested in other `binary_operator`s. Walks ancestors only; never the subtree.
fn is_in_type_position(node: &Node) -> bool {
    let mut current = *node;
    while let Some(parent) = current.parent() {
        match parent.kind() {
            "type" => return true,
            "binary_operator" => current = parent,
            _ => return false,
        }
    }
    false
}

fn emit_type_reference(
    refs: &mut Vec<RawReference>,
    from_id: &NodeId,
    name: String,
    span_node: &Node,
) {
    if is_python_builtin_type(&name) || is_typing_construct(&name) {
        return;
    }
    push_ref(refs, from_id, RawRefKind::TypeReference, name, span_node);
}

// ---------------------------------------------------------------------------
// Inheritance
// ---------------------------------------------------------------------------

/// Class base list: `class A(base.Mixin, Generic[T], metaclass=Meta)`.
/// Only fires when the `argument_list` belongs to a `class_definition`.
fn collect_superclasses(source: &str, node: &Node, from_id: &NodeId, refs: &mut Vec<RawReference>) {
    let is_superclass_list = node
        .parent()
        .map(|p| p.kind() == "class_definition")
        .unwrap_or(false);
    if !is_superclass_list {
        return;
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        // `Generic[T]` -> the generic base; `metaclass=Meta` -> the value.
        let target = match child.kind() {
            "identifier" | "attribute" => Some(child),
            "subscript" => child.child_by_field_name("value"),
            "keyword_argument" => child.child_by_field_name("value"),
            _ => None,
        };
        let Some(target) = target else { continue };
        let Some(name) = leaf_name(&target, source) else {
            continue;
        };
        push_ref(refs, from_id, RawRefKind::Inheritance, name, &child);
    }
}

// ---------------------------------------------------------------------------
// Module-level bindings
// ---------------------------------------------------------------------------

/// Classify a module-level `NAME = ...` binding as a Constant or TypeAlias
/// block. Deliberately narrow to avoid graph explosion: the assignment must sit
/// directly in the module body and bind a single plain identifier, so class
/// fields and function locals never become nodes.
fn classify_module_level_assignment(
    node: &Node,
    source: &str,
) -> Option<(BlockKind, String, Option<Visibility>)> {
    let statement = node.parent()?;
    if statement.kind() != "expression_statement" {
        return None;
    }
    if statement.parent()?.kind() != "module" {
        return None;
    }

    let left = node.child_by_field_name("left")?;
    if left.kind() != "identifier" {
        return None;
    }
    let name = node_text(&left, source)?;
    if name.is_empty() {
        return None;
    }

    let kind = if is_type_alias_binding(node, source) {
        BlockKind::TypeAlias
    } else {
        BlockKind::Constant
    };
    Some((kind, name.clone(), Some(python_visibility(&name))))
}

/// `X: TypeAlias = ...`, `T = TypeVar("T")`, `UserId = NewType(...)`,
/// `P = ParamSpec(...)`, `Ts = TypeVarTuple(...)`.
fn is_type_alias_binding(node: &Node, source: &str) -> bool {
    if let Some(annotation) = node.child_by_field_name("type") {
        if let Some(inner) = annotation.named_child(0) {
            if leaf_name(&inner, source).as_deref() == Some("TypeAlias") {
                return true;
            }
        }
    }

    let Some(right) = node.child_by_field_name("right") else {
        return false;
    };
    if right.kind() != "call" {
        return false;
    }
    let Some(func) = right.child_by_field_name("function") else {
        return false;
    };
    matches!(
        leaf_name(&func, source).as_deref(),
        Some("TypeVar" | "NewType" | "ParamSpec" | "TypeVarTuple")
    )
}

// ---------------------------------------------------------------------------
// Name filters
// ---------------------------------------------------------------------------

/// Check if a Python type name is a built-in type that won't resolve to a user symbol.
fn is_python_builtin_type(name: &str) -> bool {
    matches!(
        name,
        "int"
            | "str"
            | "float"
            | "bool"
            | "bytes"
            | "list"
            | "dict"
            | "set"
            | "tuple"
            | "None"
            | "type"
            | "object"
            | "complex"
            | "range"
            | "frozenset"
            | "bytearray"
            | "memoryview"
    )
}

/// Names from `typing` / `collections.abc` used as annotation scaffolding. They
/// are never user symbols, so emitting them only inflates edge weights and
/// pollutes the ambiguous-resolution tier.
fn is_typing_construct(name: &str) -> bool {
    matches!(
        name,
        "Any"
            | "Annotated"
            | "AnyStr"
            | "AsyncContextManager"
            | "AsyncGenerator"
            | "AsyncIterable"
            | "AsyncIterator"
            | "Awaitable"
            | "Callable"
            | "ChainMap"
            | "ClassVar"
            | "Collection"
            | "Container"
            | "ContextManager"
            | "Coroutine"
            | "Counter"
            | "DefaultDict"
            | "Deque"
            | "Dict"
            | "Final"
            | "FrozenSet"
            | "Generator"
            | "Generic"
            | "Hashable"
            | "IO"
            | "Iterable"
            | "Iterator"
            | "List"
            | "Literal"
            | "Mapping"
            | "Match"
            | "MutableMapping"
            | "MutableSequence"
            | "MutableSet"
            | "NamedTuple"
            | "Never"
            | "NewType"
            | "NoReturn"
            | "Optional"
            | "OrderedDict"
            | "ParamSpec"
            | "Pattern"
            | "Protocol"
            | "Required"
            | "Reversible"
            | "Self"
            | "Sequence"
            | "Set"
            | "Sized"
            | "Text"
            | "Tuple"
            | "Type"
            | "TypeAlias"
            | "TypeVar"
            | "TypeVarTuple"
            | "TypedDict"
            | "Union"
            | "Unpack"
            | "NotRequired"
            | "BinaryIO"
            | "TextIO"
    )
}
