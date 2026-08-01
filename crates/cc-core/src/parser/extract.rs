use crate::model::{CodeNode, Language, NodeId, Span};

use super::language::LanguageSupport;
use super::python::PythonSupport;
use super::rust_lang::RustSupport;
use super::typescript::{JavaScriptSupport, TypeScriptSupport};

/// Raw reference found during parsing, before resolution.
#[derive(Debug, Clone)]
pub struct RawReference {
    pub from_node: NodeId,
    pub kind: RawRefKind,
    pub name: String,
    pub span: Span,
}

#[derive(Debug, Clone)]
pub enum RawRefKind {
    Import {
        module_path: String,
    },
    /// A `from <module> import <original> [as <local>]` name binding.
    ///
    /// **This variant deliberately produces no edge.** It is resolution
    /// *context*, not a reference: the file already emits one
    /// [`RawRefKind::Import`] for the module (which is what draws the Import
    /// edge), and turning every imported name into its own edge would multiply
    /// symbol-edge volume without adding information. What it does instead is
    /// tell [`crate::resolver::SymbolTable`] that, inside this file, the local
    /// name `local` denotes the symbol `original` defined in `module_path`. That
    /// lets a later use of `local` resolve to the right symbol in the right
    /// file — including through an `as` rename, which is otherwise unresolvable.
    ///
    /// [`crate::resolver::ImportResolver`] matches only `Import { .. }`, so this
    /// variant never produces a duplicate file-to-file Import edge either.
    ///
    /// `RawReference::name` carries `local` (the name a use site would write).
    ImportedSymbol {
        /// Module path exactly as written, same shape as `Import::module_path`
        /// (leading dots preserved for relative imports).
        module_path: String,
        /// The name as defined in the imported module.
        original: String,
        /// The name bound in the importing file (equals `original` when there
        /// is no `as` clause).
        local: String,
    },
    FunctionCall,
    MethodCall,
    /// A method call whose receiver is the enclosing instance itself
    /// (`self.helper()`, `cls.build()`). Resolves exactly like
    /// [`RawRefKind::MethodCall`] (same [`crate::model::EdgeKind`]) but the
    /// resolver can first look for the method on the enclosing class instead of
    /// matching any same-named method in the file. Only Python emits it.
    SelfMethodCall,
    TypeReference,
    Inheritance,
    TraitImpl,
    VariableUsage,
}

/// Progress event emitted during parsing.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type")]
pub enum ParseEvent {
    FileStart {
        path: String,
    },
    FileDone {
        path: String,
        blocks: usize,
    },
    Error {
        path: String,
        message: String,
    },
    Complete {
        total_files: usize,
        total_blocks: usize,
    },
}

/// Extracts code blocks from a single source file using tree-sitter.
pub struct Extractor;

impl Extractor {
    /// Parse a single file and return code block nodes + raw references.
    pub fn extract_file(
        file_path: &str,
        source: &str,
        language: &Language,
    ) -> anyhow::Result<(Vec<CodeNode>, Vec<RawReference>)> {
        let lang_support: Box<dyn LanguageSupport> = match language {
            Language::Python => Box::new(PythonSupport),
            Language::TypeScript => Box::new(TypeScriptSupport),
            Language::JavaScript => Box::new(JavaScriptSupport),
            Language::Rust => Box::new(RustSupport),
        };

        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&lang_support.tree_sitter_language())?;

        let tree = parser
            .parse(source, None)
            .ok_or_else(|| anyhow::anyhow!("Failed to parse {}", file_path))?;

        let mut nodes = Vec::new();
        let mut refs = Vec::new();

        let file_id = NodeId::file(file_path);

        // Single pass over the whole tree. Attribution starts at the file node so
        // top-level imports/refs are captured, then switches to the innermost
        // enclosing block as the walk descends into classified blocks.
        Self::walk_tree(
            file_path,
            source,
            lang_support.as_ref(),
            &tree.root_node(),
            &file_id,
            &mut nodes,
            &mut refs,
        );

        // Post-pass: populate each block's `children` from the `parent` links.
        Self::link_block_children(&mut nodes);

        Ok((nodes, refs))
    }

    /// Walk the entire file tree exactly once. `attribution_id` is the innermost
    /// enclosing block (or the file) that references at this node should be
    /// attributed to. When a node classifies as a block, we create the block node
    /// and switch attribution to it for that node and its subtree; the block node
    /// itself then has references collected under its own id (e.g. a Rust
    /// `impl_item` both classifies and emits a `TraitImpl` ref).
    fn walk_tree(
        file_path: &str,
        source: &str,
        lang: &dyn LanguageSupport,
        node: &tree_sitter::Node,
        attribution_id: &NodeId,
        out_nodes: &mut Vec<CodeNode>,
        out_refs: &mut Vec<RawReference>,
    ) {
        let kind = node.kind();

        // Determine the attribution id for this node and its subtree. If the node
        // is a code block, create it and switch attribution to the new block id.
        let mut current_id = attribution_id.clone();

        if let Some((block_kind, name, visibility)) = lang.classify_node(kind, node, source) {
            let span = Span {
                start_line: node.start_position().row + 1,
                start_col: node.start_position().column,
                end_line: node.end_position().row + 1,
                end_col: node.end_position().column,
            };

            let signature = Self::extract_signature(node, source);

            let block_id = NodeId::code_block(file_path, &name, span.start_line);

            out_nodes.push(CodeNode::CodeBlock {
                id: block_id.clone(),
                name,
                kind: block_kind,
                span,
                signature,
                visibility,
                parent: attribution_id.clone(),
                children: Vec::new(),
            });

            current_id = block_id;
        }

        // Collect references for this exact node under the current attribution id.
        lang.collect_node_references(source, node, &current_id, out_refs);

        // Recurse into children with the (possibly updated) attribution id.
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            Self::walk_tree(
                file_path,
                source,
                lang,
                &child,
                &current_id,
                out_nodes,
                out_refs,
            );
        }
    }

    /// Populate each block's `children` vec from the `parent` links produced
    /// during the walk. Only blocks whose parent is another block in this file
    /// are linked; blocks parented directly to the file are left for the caller
    /// (they become the File node's children).
    fn link_block_children(nodes: &mut [CodeNode]) {
        // Map block id -> index for O(1) parent lookup.
        let index_of: std::collections::HashMap<NodeId, usize> = nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.id().clone(), i))
            .collect();

        // Collect (parent_index, child_id) pairs where the parent is a block.
        let links: Vec<(usize, NodeId)> = nodes
            .iter()
            .filter_map(|n| {
                if let CodeNode::CodeBlock { id, parent, .. } = n {
                    index_of.get(parent).map(|&pi| (pi, id.clone()))
                } else {
                    None
                }
            })
            .collect();

        for (parent_index, child_id) in links {
            nodes[parent_index].children_mut().push(child_id);
        }
    }

    /// Get the text of a named child field.
    pub(crate) fn child_text(
        node: &tree_sitter::Node,
        field: &str,
        source: &str,
    ) -> Option<String> {
        node.child_by_field_name(field)
            .and_then(|n| n.utf8_text(source.as_bytes()).ok())
            .map(|s| s.to_string())
    }

    /// Extract a rough signature from the first line of a node.
    pub(crate) fn extract_signature(node: &tree_sitter::Node, source: &str) -> Option<String> {
        let text = node.utf8_text(source.as_bytes()).ok()?;
        let first_line = text.lines().next()?;
        Some(first_line.trim().to_string())
    }

    /// Create a Span from a tree-sitter Node.
    pub(crate) fn node_span(node: &tree_sitter::Node) -> Span {
        Span {
            start_line: node.start_position().row + 1,
            start_col: node.start_position().column,
            end_line: node.end_position().row + 1,
            end_col: node.end_position().column,
        }
    }

    /// Extract the actual function name from a call expression.
    /// Handles: foo(), self.foo(), Self::foo(), module::foo(), obj.method()
    pub(crate) fn extract_function_name(node: &tree_sitter::Node, source: &str) -> String {
        let text = match node.utf8_text(source.as_bytes()) {
            Ok(t) => t,
            Err(_) => return String::new(),
        };

        // Handle method calls: take last segment after . or ::
        if let Some(pos) = text.rfind("::") {
            return text[pos + 2..].to_string();
        }
        if let Some(pos) = text.rfind('.') {
            return text[pos + 1..].to_string();
        }

        text.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BlockKind, Language, Visibility};

    // -- Helpers --

    fn extract(source: &str, lang: &Language) -> (Vec<CodeNode>, Vec<RawReference>) {
        Extractor::extract_file("test.file", source, lang).expect("extraction should succeed")
    }

    fn refs_of_kind(
        refs: &[RawReference],
        kind_match: fn(&RawRefKind) -> bool,
    ) -> Vec<&RawReference> {
        refs.iter().filter(|r| kind_match(&r.kind)).collect()
    }

    // -- F1: MethodCall tests --

    #[test]
    fn test_python_method_call() {
        let source = "def foo():\n    obj.method()\n    bar()";
        let (_, refs) = extract(source, &Language::Python);

        // obj.method() should produce a MethodCall ref for "method"
        let method_refs = refs_of_kind(&refs, |k| matches!(k, RawRefKind::MethodCall));
        assert!(
            method_refs.iter().any(|r| r.name == "method"),
            "expected MethodCall reference for 'method', got: {:?}",
            method_refs.iter().map(|r| &r.name).collect::<Vec<_>>()
        );

        // bar() should remain a FunctionCall, not a MethodCall
        let func_refs = refs_of_kind(&refs, |k| matches!(k, RawRefKind::FunctionCall));
        assert!(
            func_refs.iter().any(|r| r.name == "bar"),
            "expected FunctionCall reference for 'bar'"
        );

        // Ensure "method" is NOT also a FunctionCall (no double-counting)
        assert!(
            !func_refs.iter().any(|r| r.name == "method"),
            "method should not be double-counted as FunctionCall"
        );
    }

    fn find_block<'a>(nodes: &'a [CodeNode], name: &str) -> &'a CodeNode {
        nodes
            .iter()
            .find(|n| {
                if let CodeNode::CodeBlock { name: n_name, .. } = n {
                    n_name == name
                } else {
                    false
                }
            })
            .unwrap_or_else(|| panic!("no code block named '{}'", name))
    }

    fn find_block_by_kind<'a>(nodes: &'a [CodeNode], kind: &BlockKind) -> &'a CodeNode {
        nodes
            .iter()
            .find(|n| {
                if let CodeNode::CodeBlock { kind: k, .. } = n {
                    k == kind
                } else {
                    false
                }
            })
            .unwrap_or_else(|| panic!("no code block with kind {:?}", kind))
    }

    // -- Python tests --

    #[test]
    fn test_extract_python_function() {
        let (nodes, _) = extract("def foo(): pass", &Language::Python);
        let block = find_block(&nodes, "foo");
        if let CodeNode::CodeBlock { kind, name, .. } = block {
            assert_eq!(*kind, BlockKind::Function);
            assert_eq!(name, "foo");
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_python_class() {
        let (nodes, _) = extract("class Foo:\n    pass", &Language::Python);
        let block = find_block(&nodes, "Foo");
        if let CodeNode::CodeBlock { kind, name, .. } = block {
            assert_eq!(*kind, BlockKind::Class);
            assert_eq!(name, "Foo");
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_python_private_function() {
        let (nodes, _) = extract("def _private(): pass", &Language::Python);
        let block = find_block(&nodes, "_private");
        if let CodeNode::CodeBlock { visibility, .. } = block {
            assert_eq!(*visibility, Some(Visibility::Private));
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_python_imports() {
        // Import statements inside a function body are collected as references,
        // attributed to the enclosing function block.
        let source = "def setup():\n    import os\n    from os import path";
        let (_, refs) = extract(source, &Language::Python);
        let import_refs: Vec<_> = refs
            .iter()
            .filter(|r| matches!(&r.kind, RawRefKind::Import { .. }))
            .collect();
        assert!(
            !import_refs.is_empty(),
            "expected at least one import reference inside function"
        );

        // Top-level imports are attributed to the file NodeId.
        let source_top = "import os\nfrom os import path";
        let (_, refs_top) = extract(source_top, &Language::Python);
        let top_imports: Vec<_> = refs_top
            .iter()
            .filter(|r| matches!(&r.kind, RawRefKind::Import { .. }))
            .collect();
        assert!(
            !top_imports.is_empty(),
            "top-level imports should produce Import refs"
        );
        let file_id = NodeId::file("test.file");
        assert!(
            top_imports.iter().all(|r| r.from_node == file_id),
            "top-level imports should be attributed to the file NodeId"
        );
        assert!(
            top_imports.iter().any(|r| r.name == "os"),
            "expected top-level import ref for 'os'"
        );
    }

    #[test]
    fn test_extract_python_function_calls() {
        let source = "def foo():\n    bar()";
        let (nodes, refs) = extract(source, &Language::Python);
        // Should have a function "foo"
        assert!(!nodes.is_empty());
        // Should have a FunctionCall reference to "bar"
        let call_refs: Vec<_> = refs
            .iter()
            .filter(|r| matches!(r.kind, RawRefKind::FunctionCall) && r.name == "bar")
            .collect();
        assert!(
            !call_refs.is_empty(),
            "expected FunctionCall reference for 'bar'"
        );
    }

    #[test]
    fn test_ts_method_call() {
        let source = "function foo() { obj.method(); bar(); }";
        let (_, refs) = extract(source, &Language::TypeScript);

        let method_refs = refs_of_kind(&refs, |k| matches!(k, RawRefKind::MethodCall));
        assert!(
            method_refs.iter().any(|r| r.name == "method"),
            "expected MethodCall reference for 'method', got: {:?}",
            method_refs.iter().map(|r| &r.name).collect::<Vec<_>>()
        );

        let func_refs = refs_of_kind(&refs, |k| matches!(k, RawRefKind::FunctionCall));
        assert!(
            func_refs.iter().any(|r| r.name == "bar"),
            "expected FunctionCall reference for 'bar'"
        );

        assert!(
            !func_refs.iter().any(|r| r.name == "method"),
            "method should not be double-counted as FunctionCall"
        );
    }

    #[test]
    fn test_rust_method_call() {
        let source = "fn foo() { self.method(); foo.bar(); Vec::new(); baz(); }";
        let (_, refs) = extract(source, &Language::Rust);

        let method_refs = refs_of_kind(&refs, |k| matches!(k, RawRefKind::MethodCall));
        assert!(
            method_refs.iter().any(|r| r.name == "method"),
            "expected MethodCall for 'method', got: {:?}",
            method_refs.iter().map(|r| &r.name).collect::<Vec<_>>()
        );
        assert!(
            method_refs.iter().any(|r| r.name == "bar"),
            "expected MethodCall for 'bar' (foo.bar())"
        );

        // Vec::new() should be FunctionCall (path call, not method call)
        let func_refs = refs_of_kind(&refs, |k| matches!(k, RawRefKind::FunctionCall));
        assert!(
            func_refs.iter().any(|r| r.name == "new"),
            "expected FunctionCall for 'new' (Vec::new())"
        );

        // baz() should be FunctionCall
        assert!(
            func_refs.iter().any(|r| r.name == "baz"),
            "expected FunctionCall for 'baz'"
        );

        // method and bar should NOT appear as FunctionCall
        assert!(
            !func_refs.iter().any(|r| r.name == "method"),
            "method should not be double-counted as FunctionCall"
        );
    }

    // -- F2: TypeReference tests --

    #[test]
    fn test_python_type_annotation() {
        // Only custom types should be extracted, not built-ins like int/str
        let source = "def foo(x: MyClass) -> MyResult:\n    pass";
        let (_, refs) = extract(source, &Language::Python);

        let type_refs = refs_of_kind(&refs, |k| matches!(k, RawRefKind::TypeReference));
        assert!(
            type_refs.iter().any(|r| r.name == "MyClass"),
            "expected TypeReference for 'MyClass', got: {:?}",
            type_refs.iter().map(|r| &r.name).collect::<Vec<_>>()
        );
        assert!(
            type_refs.iter().any(|r| r.name == "MyResult"),
            "expected TypeReference for 'MyResult'"
        );

        // Built-in types should NOT produce TypeReference refs
        let source_builtins = "def bar(x: int) -> str:\n    pass";
        let (_, refs_builtins) = extract(source_builtins, &Language::Python);
        let type_refs_builtins =
            refs_of_kind(&refs_builtins, |k| matches!(k, RawRefKind::TypeReference));
        assert!(
            !type_refs_builtins.iter().any(|r| r.name == "int"),
            "built-in 'int' should not produce TypeReference"
        );
        assert!(
            !type_refs_builtins.iter().any(|r| r.name == "str"),
            "built-in 'str' should not produce TypeReference"
        );
    }

    #[test]
    fn test_ts_type_annotation() {
        // Custom types (type_identifier) should produce TypeReference
        let source = "function foo(x: Foo): Bar {}";
        let (_, refs) = extract(source, &Language::TypeScript);

        let type_refs = refs_of_kind(&refs, |k| matches!(k, RawRefKind::TypeReference));
        assert!(
            type_refs.iter().any(|r| r.name == "Foo"),
            "expected TypeReference for 'Foo', got: {:?}",
            type_refs.iter().map(|r| &r.name).collect::<Vec<_>>()
        );
        assert!(
            type_refs.iter().any(|r| r.name == "Bar"),
            "expected TypeReference for 'Bar'"
        );

        // Built-in types (predefined_type) should NOT produce TypeReference
        let source_builtins = "function bar(x: number): string {}";
        let (_, refs_builtins) = extract(source_builtins, &Language::TypeScript);
        let type_refs_builtins =
            refs_of_kind(&refs_builtins, |k| matches!(k, RawRefKind::TypeReference));
        assert!(
            !type_refs_builtins.iter().any(|r| r.name == "number"),
            "built-in 'number' should not produce TypeReference"
        );
        assert!(
            !type_refs_builtins.iter().any(|r| r.name == "string"),
            "built-in 'string' should not produce TypeReference"
        );
    }

    #[test]
    fn test_rust_type_annotation() {
        let source = "fn foo(x: Bar) -> Baz {}";
        let (_, refs) = extract(source, &Language::Rust);

        let type_refs = refs_of_kind(&refs, |k| matches!(k, RawRefKind::TypeReference));
        assert!(
            type_refs.iter().any(|r| r.name == "Bar"),
            "expected TypeReference for 'Bar', got: {:?}",
            type_refs.iter().map(|r| &r.name).collect::<Vec<_>>()
        );
        assert!(
            type_refs.iter().any(|r| r.name == "Baz"),
            "expected TypeReference for 'Baz'"
        );
    }

    // -- F3: Inheritance tests --

    #[test]
    fn test_python_inheritance() {
        let source = "class Foo(Bar):\n    pass";
        let (_, refs) = extract(source, &Language::Python);

        let inherit_refs = refs_of_kind(&refs, |k| matches!(k, RawRefKind::Inheritance));
        assert!(
            inherit_refs.iter().any(|r| r.name == "Bar"),
            "expected Inheritance reference to 'Bar', got: {:?}",
            inherit_refs.iter().map(|r| &r.name).collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_extract_python_nested_class_method() {
        let source = "class Foo:\n    def bar(self):\n        pass";
        let (nodes, _) = extract(source, &Language::Python);

        let class_block = find_block(&nodes, "Foo");
        let method_block = find_block(&nodes, "bar");

        let class_id = if let CodeNode::CodeBlock { id, .. } = class_block {
            id.clone()
        } else {
            panic!("expected CodeBlock");
        };

        if let CodeNode::CodeBlock { parent, .. } = method_block {
            assert_eq!(
                *parent, class_id,
                "method's parent should be the class block"
            );
        } else {
            panic!("expected CodeBlock");
        }
    }

    // -- Python extraction gap tests (imports, inheritance, annotations,
    //    module-level bindings, decorators, dunder visibility) --

    /// Collect the `module_path` of every Import ref, in source order.
    fn python_import_paths(source: &str) -> Vec<String> {
        let (_, refs) = extract(source, &Language::Python);
        refs.iter()
            .filter_map(|r| match &r.kind {
                RawRefKind::Import { module_path } => Some(module_path.clone()),
                _ => None,
            })
            .collect()
    }

    /// Collect TypeReference ref names, sorted for stable comparison.
    fn python_type_ref_names(source: &str) -> Vec<String> {
        let (_, refs) = extract(source, &Language::Python);
        let mut names: Vec<String> = refs
            .iter()
            .filter(|r| matches!(r.kind, RawRefKind::TypeReference))
            .map(|r| r.name.clone())
            .collect();
        names.sort();
        names
    }

    /// Collect Inheritance ref names, sorted.
    fn python_inheritance_names(source: &str) -> Vec<String> {
        let (_, refs) = extract(source, &Language::Python);
        let mut names: Vec<String> = refs
            .iter()
            .filter(|r| matches!(r.kind, RawRefKind::Inheritance))
            .map(|r| r.name.clone())
            .collect();
        names.sort();
        names
    }

    fn block_names(nodes: &[CodeNode]) -> Vec<String> {
        nodes
            .iter()
            .filter_map(|n| match n {
                CodeNode::CodeBlock { name, .. } => Some(name.clone()),
                _ => None,
            })
            .collect()
    }

    fn block_kind_of(nodes: &[CodeNode], name: &str) -> BlockKind {
        match find_block(nodes, name) {
            CodeNode::CodeBlock { kind, .. } => kind.clone(),
            _ => panic!("expected CodeBlock"),
        }
    }

    fn block_visibility_of(nodes: &[CodeNode], name: &str) -> Option<Visibility> {
        match find_block(nodes, name) {
            CodeNode::CodeBlock { visibility, .. } => visibility.clone(),
            _ => panic!("expected CodeBlock"),
        }
    }

    // -- B1: import module_path contract --

    #[test]
    fn test_python_import_module_path_contract() {
        // This table is the cross-workstream contract consumed by the import
        // resolver: a clean dotted module path exactly as written in source,
        // with the `as` alias clause stripped and imported symbols excluded.
        assert_eq!(python_import_paths("import os, sys"), vec!["os", "sys"]);
        assert_eq!(python_import_paths("import numpy as np"), vec!["numpy"]);
        assert_eq!(python_import_paths("import a.b.c"), vec!["a.b.c"]);
        assert_eq!(
            python_import_paths("from mypkg.mod import Thing, other"),
            vec!["mypkg.mod"]
        );
        assert_eq!(python_import_paths("from .rel import X as Y"), vec![".rel"]);
        assert_eq!(python_import_paths("from . import x"), vec!["."]);
        assert_eq!(
            python_import_paths("from ..pkg.sub import y"),
            vec!["..pkg.sub"]
        );
    }

    #[test]
    fn test_python_import_multi_and_alias_combined() {
        assert_eq!(
            python_import_paths("import os, numpy as np, a.b.c"),
            vec!["os", "numpy", "a.b.c"]
        );
    }

    #[test]
    fn test_python_import_wildcard_yields_module_only() {
        assert_eq!(
            python_import_paths("from pkg.mod import *"),
            vec!["pkg.mod"]
        );
    }

    #[test]
    fn test_python_import_symbols_never_leak_as_imports() {
        // `from x import A, B` must produce exactly one Import ref (the module),
        // never one per imported symbol.
        let paths = python_import_paths("from mypkg.mod import Thing, other");
        assert_eq!(
            paths.len(),
            1,
            "expected exactly one Import ref, got {:?}",
            paths
        );
        assert!(
            !paths
                .iter()
                .any(|p| p.contains("Thing") || p.contains("other")),
            "imported symbol names must not appear in module_path, got {:?}",
            paths
        );
    }

    #[test]
    fn test_python_import_ref_name_matches_module_path() {
        let (_, refs) = extract("import numpy as np", &Language::Python);
        let import_ref = refs
            .iter()
            .find(|r| matches!(r.kind, RawRefKind::Import { .. }))
            .expect("expected an Import ref");
        assert_eq!(import_ref.name, "numpy");
    }

    // -- B2: inheritance beyond bare identifiers --

    #[test]
    fn test_python_inheritance_attribute_subscript_and_keyword() {
        let source = "class A(base.Mixin, Generic[T], metaclass=Meta):\n    pass";
        assert_eq!(
            python_inheritance_names(source),
            vec!["Generic", "Meta", "Mixin"]
        );
    }

    #[test]
    fn test_python_inheritance_dotted_metaclass() {
        let source = "class D(object, metaclass=abc.ABCMeta):\n    pass";
        assert_eq!(python_inheritance_names(source), vec!["ABCMeta", "object"]);
    }

    #[test]
    fn test_python_inheritance_dotted_subscript_base() {
        let source = "class E(pkg.mod.Base[T]):\n    pass";
        assert_eq!(python_inheritance_names(source), vec!["Base"]);
    }

    #[test]
    fn test_python_inheritance_attributed_to_class_block() {
        let source = "class Foo(Bar):\n    pass";
        let (nodes, refs) = extract(source, &Language::Python);
        let class_id = block_id_of(&nodes, "Foo");
        let inherit: Vec<_> = refs
            .iter()
            .filter(|r| matches!(r.kind, RawRefKind::Inheritance))
            .collect();
        assert_eq!(inherit.len(), 1);
        assert_eq!(inherit[0].from_node, class_id);
    }

    // -- B3: generic annotations emit only leaf type names --

    #[test]
    fn test_python_generic_annotation_emits_single_leaf() {
        // `list[MyClass]` must yield exactly ONE TypeReference, named MyClass.
        assert_eq!(
            python_type_ref_names("def f(x: list[MyClass]):\n    pass"),
            vec!["MyClass"]
        );
    }

    #[test]
    fn test_python_annotations_skip_builtins_and_typing_constructs() {
        let source = "def f(x: list[MyClass], y: Optional[Other]) -> Dict[str, Thing]:\n    pass";
        assert_eq!(
            python_type_ref_names(source),
            vec!["MyClass", "Other", "Thing"]
        );
    }

    #[test]
    fn test_python_dotted_and_union_annotations() {
        let source = "def f(a: mod.Thing, b: A | B) -> pkg.sub.Result:\n    pass";
        assert_eq!(
            python_type_ref_names(source),
            vec!["A", "B", "Result", "Thing"]
        );
    }

    #[test]
    fn test_python_nested_union_annotation() {
        assert_eq!(
            python_type_ref_names("def f(a: A | B | C):\n    pass"),
            vec!["A", "B", "C"]
        );
    }

    #[test]
    fn test_python_user_generic_base_is_emitted() {
        assert_eq!(
            python_type_ref_names("def f(x: MyGeneric[Inner]):\n    pass"),
            vec!["Inner", "MyGeneric"]
        );
    }

    #[test]
    fn test_python_nested_generic_annotation_no_duplicates() {
        assert_eq!(
            python_type_ref_names("def f(x: list[list[X]]):\n    pass"),
            vec!["X"]
        );
    }

    #[test]
    fn test_python_none_return_annotation_emits_nothing() {
        assert!(python_type_ref_names("def g() -> None:\n    pass").is_empty());
    }

    // -- B4: module-level constants and type aliases --

    #[test]
    fn test_python_module_level_constant_block() {
        let (nodes, _) = extract("MAX = 10", &Language::Python);
        assert_eq!(block_kind_of(&nodes, "MAX"), BlockKind::Constant);
        let file_id = NodeId::file("test.file");
        if let CodeNode::CodeBlock { parent, .. } = find_block(&nodes, "MAX") {
            assert_eq!(
                *parent, file_id,
                "module-level constant parents to the file"
            );
        }
    }

    #[test]
    fn test_python_module_level_binding_defaults_to_constant() {
        let (nodes, _) = extract("Alias = MyClass", &Language::Python);
        assert_eq!(block_kind_of(&nodes, "Alias"), BlockKind::Constant);
    }

    #[test]
    fn test_python_module_level_type_alias_shapes() {
        let source = "T = TypeVar('T')\nUserId = NewType('UserId', int)\nX: TypeAlias = MyClass\nP = ParamSpec('P')";
        let (nodes, _) = extract(source, &Language::Python);
        assert_eq!(block_kind_of(&nodes, "T"), BlockKind::TypeAlias);
        assert_eq!(block_kind_of(&nodes, "UserId"), BlockKind::TypeAlias);
        assert_eq!(block_kind_of(&nodes, "X"), BlockKind::TypeAlias);
        assert_eq!(block_kind_of(&nodes, "P"), BlockKind::TypeAlias);
    }

    #[test]
    fn test_python_annotated_module_constant() {
        let (nodes, _) = extract("CONFIG: Settings = Settings()", &Language::Python);
        assert_eq!(block_kind_of(&nodes, "CONFIG"), BlockKind::Constant);
    }

    #[test]
    fn test_python_module_constant_owns_its_initializer_refs() {
        let (nodes, refs) = extract("CONFIG: Settings = Settings()", &Language::Python);
        let const_id = block_id_of(&nodes, "CONFIG");
        let type_refs: Vec<_> = refs
            .iter()
            .filter(|r| matches!(r.kind, RawRefKind::TypeReference))
            .collect();
        assert!(
            type_refs.iter().all(|r| r.from_node == const_id),
            "annotation refs should attribute to the constant block"
        );
    }

    #[test]
    fn test_python_local_and_class_field_assignments_create_no_blocks() {
        let source = "class C:\n    field = 1\n    typed: int = 2\n    def m(self):\n        x = 1\n        y: int = 2";
        let (nodes, _) = extract(source, &Language::Python);
        let mut names = block_names(&nodes);
        names.sort();
        assert_eq!(
            names,
            vec!["C", "m"],
            "only the class and method should be blocks; got {:?}",
            names
        );
    }

    #[test]
    fn test_python_function_local_assignment_creates_no_block() {
        let (nodes, _) = extract("def f():\n    x = 1", &Language::Python);
        let mut names = block_names(&nodes);
        names.sort();
        assert_eq!(names, vec!["f"]);
    }

    #[test]
    fn test_python_tuple_unpacking_creates_no_block() {
        let (nodes, _) = extract("a, b = 1, 2", &Language::Python);
        assert!(
            block_names(&nodes).is_empty(),
            "tuple unpacking should not create blocks, got {:?}",
            block_names(&nodes)
        );
    }

    #[test]
    fn test_python_subscript_assignment_creates_no_block() {
        let (nodes, _) = extract("REGISTRY['a'] = 1\nobj.attr = 2", &Language::Python);
        assert!(
            block_names(&nodes).is_empty(),
            "non-identifier assignment targets should not create blocks, got {:?}",
            block_names(&nodes)
        );
    }

    #[test]
    fn test_python_module_constant_visibility() {
        let (nodes, _) = extract("MAX = 1\n_HIDDEN = 2", &Language::Python);
        assert_eq!(block_visibility_of(&nodes, "MAX"), Some(Visibility::Public));
        assert_eq!(
            block_visibility_of(&nodes, "_HIDDEN"),
            Some(Visibility::Private)
        );
    }

    // -- B5: decorators --

    #[test]
    fn test_python_bare_decorator_reference() {
        let source = "@my_decorator\ndef handler():\n    pass";
        let (_, refs) = extract(source, &Language::Python);
        let hits: Vec<_> = refs.iter().filter(|r| r.name == "my_decorator").collect();
        assert_eq!(
            hits.len(),
            1,
            "expected exactly one ref for the bare decorator, got {:?}",
            hits.iter().map(|r| (&r.name, &r.kind)).collect::<Vec<_>>()
        );
        assert!(matches!(hits[0].kind, RawRefKind::FunctionCall));
    }

    #[test]
    fn test_python_dotted_decorator_reference() {
        let source = "@decorators.cached\ndef handler():\n    pass";
        let (_, refs) = extract(source, &Language::Python);
        let hits: Vec<_> = refs.iter().filter(|r| r.name == "cached").collect();
        assert_eq!(hits.len(), 1);
        assert!(matches!(hits[0].kind, RawRefKind::MethodCall));
    }

    #[test]
    fn test_python_call_decorator_not_double_counted() {
        let source = "@app.route('/x')\ndef handler():\n    pass";
        let (_, refs) = extract(source, &Language::Python);
        let hits: Vec<_> = refs.iter().filter(|r| r.name == "route").collect();
        assert_eq!(
            hits.len(),
            1,
            "call-form decorator must not be double-counted, got {:?}",
            hits.iter().map(|r| (&r.name, &r.kind)).collect::<Vec<_>>()
        );
        assert!(matches!(hits[0].kind, RawRefKind::MethodCall));
        // The decorated function's receiver `app` must not become a ref of its own.
        assert!(!refs.iter().any(|r| r.name == "app"));
    }

    #[test]
    fn test_python_decorator_on_class() {
        let source = "@decorators.cached\nclass K:\n    pass";
        let (_, refs) = extract(source, &Language::Python);
        assert!(refs.iter().any(|r| r.name == "cached"));
    }

    #[test]
    fn test_python_decorator_ref_attributed_to_enclosing_scope() {
        // The decorator sits above the function_definition inside
        // decorated_definition, so it attributes to the enclosing scope (file),
        // not the decorated function.
        let source = "@my_decorator\ndef handler():\n    pass";
        let (_, refs) = extract(source, &Language::Python);
        let file_id = NodeId::file("test.file");
        let hit = refs
            .iter()
            .find(|r| r.name == "my_decorator")
            .expect("decorator ref");
        assert_eq!(hit.from_node, file_id);
    }

    // -- B6: dunder visibility --

    #[test]
    fn test_python_dunder_methods_are_public() {
        let source = "class C:\n    def __init__(self):\n        pass\n    def __repr__(self):\n        pass\n    def __mangled(self):\n        pass\n    def _protected(self):\n        pass\n    def plain(self):\n        pass";
        let (nodes, _) = extract(source, &Language::Python);
        assert_eq!(
            block_visibility_of(&nodes, "__init__"),
            Some(Visibility::Public),
            "dunder methods are part of the public protocol"
        );
        assert_eq!(
            block_visibility_of(&nodes, "__repr__"),
            Some(Visibility::Public)
        );
        assert_eq!(
            block_visibility_of(&nodes, "__mangled"),
            Some(Visibility::Private),
            "name-mangled __x (no trailing dunder) stays private"
        );
        assert_eq!(
            block_visibility_of(&nodes, "_protected"),
            Some(Visibility::Private)
        );
        assert_eq!(
            block_visibility_of(&nodes, "plain"),
            Some(Visibility::Public)
        );
    }

    #[test]
    fn test_python_class_visibility_follows_underscore_convention() {
        let (nodes, _) = extract("class _Internal:\n    pass", &Language::Python);
        assert_eq!(
            block_visibility_of(&nodes, "_Internal"),
            Some(Visibility::Private)
        );
    }

    // -- C1: imported-symbol bindings --

    /// Collect `(module_path, original, local)` for every ImportedSymbol ref,
    /// in source order.
    fn python_symbol_bindings(source: &str) -> Vec<(String, String, String)> {
        let (_, refs) = extract(source, &Language::Python);
        refs.iter()
            .filter_map(|r| match &r.kind {
                RawRefKind::ImportedSymbol {
                    module_path,
                    original,
                    local,
                } => Some((module_path.clone(), original.clone(), local.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn test_python_from_import_emits_one_binding_per_name() {
        assert_eq!(
            python_symbol_bindings("from mypkg.mod import Thing, other"),
            vec![
                ("mypkg.mod".into(), "Thing".into(), "Thing".into()),
                ("mypkg.mod".into(), "other".into(), "other".into()),
            ]
        );
    }

    #[test]
    fn test_python_from_import_alias_binding_keeps_original_and_local() {
        assert_eq!(
            python_symbol_bindings("from mypkg.mod import Thing as T"),
            vec![("mypkg.mod".into(), "Thing".into(), "T".into())]
        );
    }

    #[test]
    fn test_python_relative_from_import_binding_keeps_leading_dots() {
        assert_eq!(
            python_symbol_bindings("from ..pkg.sub import y"),
            vec![("..pkg.sub".into(), "y".into(), "y".into())]
        );
        assert_eq!(
            python_symbol_bindings("from . import x"),
            vec![(".".into(), "x".into(), "x".into())]
        );
    }

    #[test]
    fn test_python_binding_ref_name_is_the_local_name() {
        let (_, refs) = extract("from m import Thing as T", &Language::Python);
        let binding = refs
            .iter()
            .find(|r| matches!(r.kind, RawRefKind::ImportedSymbol { .. }))
            .expect("expected an ImportedSymbol ref");
        assert_eq!(binding.name, "T");
    }

    #[test]
    fn test_python_wildcard_and_plain_imports_emit_no_bindings() {
        // `from pkg import *` binds nothing nameable.
        assert!(python_symbol_bindings("from pkg.mod import *").is_empty());
        // `import x` / `import x as y` bind a *module*, not a symbol.
        assert!(python_symbol_bindings("import numpy as np").is_empty());
        assert!(python_symbol_bindings("import os, sys").is_empty());
        // `from __future__ import annotations` is not a real module import.
        assert!(python_symbol_bindings("from __future__ import annotations").is_empty());
    }

    #[test]
    fn test_python_bindings_do_not_disturb_the_import_module_path_contract() {
        // The module-path contract the import resolver consumes is unchanged:
        // still exactly one Import ref per imported module.
        assert_eq!(
            python_import_paths("from mypkg.mod import Thing, other as o"),
            vec!["mypkg.mod"]
        );
    }

    #[test]
    fn test_python_binding_attributed_to_enclosing_scope() {
        let (_, refs) = extract("from m import Thing", &Language::Python);
        let file_id = NodeId::file("test.file");
        let binding = refs
            .iter()
            .find(|r| matches!(r.kind, RawRefKind::ImportedSymbol { .. }))
            .expect("expected an ImportedSymbol ref");
        assert_eq!(binding.from_node, file_id);
    }

    // -- C4: self-receiver method calls --

    /// Collect names of SelfMethodCall refs, sorted.
    fn python_self_call_names(source: &str) -> Vec<String> {
        let (_, refs) = extract(source, &Language::Python);
        let mut names: Vec<String> = refs
            .iter()
            .filter(|r| matches!(r.kind, RawRefKind::SelfMethodCall))
            .map(|r| r.name.clone())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn test_python_self_call_is_marked_distinctly() {
        let source = "class C:\n    def m(self):\n        self.helper()\n        other.helper()";
        assert_eq!(python_self_call_names(source), vec!["helper"]);

        // `other.helper()` stays a plain MethodCall, and the self call is not
        // double-counted as one.
        let (_, refs) = extract(source, &Language::Python);
        let method_calls: Vec<&RawReference> = refs
            .iter()
            .filter(|r| matches!(r.kind, RawRefKind::MethodCall))
            .collect();
        assert_eq!(
            method_calls.len(),
            1,
            "only `other.helper()` is a plain MethodCall, got {:?}",
            method_calls
                .iter()
                .map(|r| (&r.name, &r.kind))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_python_cls_call_is_a_self_call() {
        let source = "class C:\n    @classmethod\n    def make(cls):\n        return cls._build()";
        assert_eq!(python_self_call_names(source), vec!["_build"]);
    }

    #[test]
    fn test_python_self_attribute_call_is_not_a_self_call() {
        // `self.client.send()` calls a method on an *attribute*, not on self.
        let source = "class C:\n    def m(self):\n        self.client.send()";
        assert!(
            python_self_call_names(source).is_empty(),
            "only a direct `self.<name>()` receiver counts, got {:?}",
            python_self_call_names(source)
        );
        let (_, refs) = extract(source, &Language::Python);
        assert!(
            refs.iter()
                .any(|r| matches!(r.kind, RawRefKind::MethodCall) && r.name == "send"),
            "it is still a plain MethodCall"
        );
    }

    #[test]
    fn test_non_python_self_calls_are_unchanged() {
        // TS/Rust extraction is untouched: no language emits SelfMethodCall
        // except Python.
        for (source, lang) in [
            ("class C { m() { this.helper(); } }", Language::TypeScript),
            ("fn m(&self) { self.helper(); }", Language::Rust),
        ] {
            let (_, refs) = extract(source, &lang);
            assert!(
                !refs
                    .iter()
                    .any(|r| matches!(r.kind, RawRefKind::SelfMethodCall)),
                "{lang:?} must not emit SelfMethodCall"
            );
            assert!(
                refs.iter()
                    .any(|r| matches!(r.kind, RawRefKind::MethodCall) && r.name == "helper"),
                "{lang:?} still emits a MethodCall for `helper`"
            );
        }
    }

    // -- C2: PEP 695 `type X = Y` statements --

    #[test]
    fn test_python_pep695_type_alias_block() {
        let (nodes, _) = extract("type Alias = MyClass", &Language::Python);
        assert_eq!(block_kind_of(&nodes, "Alias"), BlockKind::TypeAlias);
        assert_eq!(block_names(&nodes), vec!["Alias"]);
    }

    #[test]
    fn test_python_pep695_type_alias_rhs_emits_type_reference() {
        assert_eq!(
            python_type_ref_names("type Alias = MyClass"),
            vec!["MyClass"],
        );
    }

    #[test]
    fn test_python_pep695_type_alias_never_self_references() {
        // The alias name on the LHS is itself a `type` node in the grammar;
        // it must not become a TypeReference from the alias block to itself.
        let (nodes, refs) = extract("type Alias = MyClass", &Language::Python);
        let alias_id = block_id_of(&nodes, "Alias");
        assert!(
            !refs.iter().any(|r| r.name == "Alias"),
            "the alias name must never appear as a reference, got {:?}",
            refs.iter().map(|r| (&r.name, &r.kind)).collect::<Vec<_>>()
        );
        assert!(
            refs.iter()
                .all(|r| r.from_node != alias_id || r.name != "Alias"),
            "no self-referencing type ref"
        );
    }

    #[test]
    fn test_python_pep695_generic_type_alias_skips_its_parameters() {
        // `type G[T] = list[T]`: the LHS (`G`, and its `[T]` parameter list) is
        // a declaration, not a reference. The RHS behaves normally: `list` is a
        // builtin (dropped), `T` is a genuine leaf reference.
        let (nodes, _) = extract("type G[T] = list[T]", &Language::Python);
        assert_eq!(block_kind_of(&nodes, "G"), BlockKind::TypeAlias);
        assert_eq!(python_type_ref_names("type G[T] = list[T]"), vec!["T"]);
    }

    #[test]
    fn test_python_pep695_type_alias_union_rhs() {
        assert_eq!(python_type_ref_names("type Alias = A | B"), vec!["A", "B"]);
    }

    // -- C3: string forward references in annotations --

    #[test]
    fn test_python_string_forward_reference() {
        assert_eq!(
            python_type_ref_names("def f(x: \"Fwd\") -> \"Ret\":\n    pass"),
            vec!["Fwd", "Ret"]
        );
    }

    #[test]
    fn test_python_string_forward_reference_inside_generic() {
        assert_eq!(
            python_type_ref_names("def f(x: List[\"Fwd\"]):\n    pass"),
            vec!["Fwd"]
        );
    }

    #[test]
    fn test_python_string_forward_reference_with_subscript_content() {
        assert_eq!(
            python_type_ref_names("def f(x: \"Optional[Fwd]\"):\n    pass"),
            vec!["Fwd"]
        );
        assert_eq!(
            python_type_ref_names("def f(x: \"dict[str, MyClass]\"):\n    pass"),
            vec!["MyClass"]
        );
        assert_eq!(
            python_type_ref_names("def f(x: \"A | B\"):\n    pass"),
            vec!["A", "B"]
        );
    }

    #[test]
    fn test_python_string_forward_reference_dotted_uses_leaf() {
        assert_eq!(
            python_type_ref_names("def f(x: \"mod.Deep\"):\n    pass"),
            vec!["Deep"]
        );
    }

    #[test]
    fn test_python_string_forward_reference_filters_builtins_and_typing() {
        assert!(python_type_ref_names("def f(x: \"int\") -> \"None\":\n    pass").is_empty());
        assert!(python_type_ref_names("def f(x: \"Any\"):\n    pass").is_empty());
        assert!(python_type_ref_names("def f(x: \"Callable[[int], str]\"):\n    pass").is_empty());
    }

    #[test]
    fn test_python_string_forward_reference_on_variable_annotation() {
        assert_eq!(
            python_type_ref_names("def f():\n    x: \"Fwd\" = make()"),
            vec!["Fwd"]
        );
    }

    #[test]
    fn test_python_docstring_is_never_a_type_reference() {
        let source = "def f(x: int):\n    \"\"\"MyClass does the thing.\"\"\"\n    return x";
        assert!(
            python_type_ref_names(source).is_empty(),
            "docstrings must not produce type references, got {:?}",
            python_type_ref_names(source)
        );
        let class_doc = "class C:\n    \"\"\"Wraps MyClass.\"\"\"\n    pass";
        assert!(python_type_ref_names(class_doc).is_empty());
        let module_doc = "\"\"\"Module docs mentioning MyClass.\"\"\"\n";
        assert!(python_type_ref_names(module_doc).is_empty());
    }

    #[test]
    fn test_python_ordinary_string_values_are_never_type_references() {
        // Default value, plain assignment, call argument, dict value, and an
        // annotated assignment whose *value* (not annotation) is a string.
        for source in [
            "def f(x: str = \"MyClass\"):\n    pass",
            "NAME = \"MyClass\"",
            "def f():\n    call(\"MyClass\")",
            "def f():\n    d = {\"MyClass\": 1}",
            "NAME: str = \"MyClass\"",
            "def f():\n    return \"MyClass\"",
        ] {
            assert!(
                python_type_ref_names(source).is_empty(),
                "string value must not become a type reference in: {source:?} (got {:?})",
                python_type_ref_names(source)
            );
        }
    }

    #[test]
    fn test_python_literal_and_annotated_strings_are_values_not_type_references() {
        // `Literal["a"]` enumerates string *values*; `Annotated[T, "note"]`
        // carries metadata. Neither is a forward reference.
        for source in [
            "def f(x: Literal[\"MyClass\"]):\n    pass",
            "def f(x: list[Literal[\"MyClass\", \"Other\"]]):\n    pass",
            "NAMES: list[Literal[\"MyClass\"]] = []",
            "def f(x: Annotated[int, \"MyClass\"]):\n    pass",
        ] {
            assert!(
                python_type_ref_names(source).is_empty(),
                "Literal/Annotated strings must not become type references in: {source:?} (got {:?})",
                python_type_ref_names(source)
            );
        }
        // A genuine forward reference in a normal generic still works.
        assert_eq!(
            python_type_ref_names("def f(x: list[\"MyClass\"]):\n    pass"),
            vec!["MyClass"]
        );
    }

    #[test]
    fn test_python_unparseable_string_annotation_emits_nothing() {
        for source in [
            "def f(x: \"not a real type!\"):\n    pass",
            "def f(x: \"lambda: 3\"):\n    pass",
            "def f(x: \"\"):\n    pass",
            "def f(x: \"1234\"):\n    pass",
            "def f(x: \"Literal['a']\"):\n    pass",
            "def f(x: f\"Fwd\"):\n    pass",
            "def f(x: b\"Fwd\"):\n    pass",
        ] {
            assert!(
                python_type_ref_names(source).is_empty(),
                "non-name string annotation must emit nothing in: {source:?} (got {:?})",
                python_type_ref_names(source)
            );
        }
    }

    // -- TypeScript tests --

    #[test]
    fn test_extract_ts_function() {
        let (nodes, _) = extract("function foo() {}", &Language::TypeScript);
        let block = find_block(&nodes, "foo");
        if let CodeNode::CodeBlock { kind, .. } = block {
            assert_eq!(*kind, BlockKind::Function);
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_ts_class() {
        let (nodes, _) = extract("class Foo {}", &Language::TypeScript);
        let block = find_block(&nodes, "Foo");
        if let CodeNode::CodeBlock { kind, .. } = block {
            assert_eq!(*kind, BlockKind::Class);
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_ts_interface() {
        let (nodes, _) = extract("interface Foo {}", &Language::TypeScript);
        let block = find_block(&nodes, "Foo");
        if let CodeNode::CodeBlock { kind, .. } = block {
            assert_eq!(*kind, BlockKind::Interface);
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_ts_type_alias() {
        let (nodes, _) = extract("type Foo = string", &Language::TypeScript);
        let block = find_block(&nodes, "Foo");
        if let CodeNode::CodeBlock { kind, .. } = block {
            assert_eq!(*kind, BlockKind::TypeAlias);
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_ts_enum() {
        let (nodes, _) = extract("enum Foo {}", &Language::TypeScript);
        let block = find_block(&nodes, "Foo");
        if let CodeNode::CodeBlock { kind, .. } = block {
            assert_eq!(*kind, BlockKind::Enum);
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_ts_arrow_function() {
        let (nodes, _) = extract("const foo = () => {}", &Language::TypeScript);
        let block = find_block(&nodes, "foo");
        if let CodeNode::CodeBlock { kind, name, .. } = block {
            assert_eq!(*kind, BlockKind::Function);
            assert_eq!(name, "foo");
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_ts_imports() {
        // Top-level import statements are attributed to the file NodeId.
        let source_top = "import { foo } from './bar'";
        let (_, refs_top) = extract(source_top, &Language::TypeScript);
        let top_imports: Vec<_> = refs_top
            .iter()
            .filter(|r| matches!(&r.kind, RawRefKind::Import { .. }))
            .collect();
        assert!(
            !top_imports.is_empty(),
            "top-level imports should produce Import refs"
        );
        let file_id = NodeId::file("test.file");
        assert!(
            top_imports.iter().all(|r| r.from_node == file_id),
            "top-level imports should be attributed to the file NodeId"
        );
        assert!(
            top_imports.iter().any(|r| r.name == "./bar"),
            "expected top-level import ref for './bar'"
        );

        // However, require() inside a function IS a call_expression
        // and gets collected as a FunctionCall ref:
        let source_dyn = "function loader() { require('./bar') }";
        let (_, refs_dyn) = extract(source_dyn, &Language::TypeScript);
        let call_refs: Vec<_> = refs_dyn
            .iter()
            .filter(|r| matches!(r.kind, RawRefKind::FunctionCall))
            .collect();
        assert!(
            !call_refs.is_empty(),
            "require() inside a function should produce a FunctionCall ref"
        );
    }

    #[test]
    fn test_extract_ts_call_expression() {
        let source = "function foo() { bar() }";
        let (_, refs) = extract(source, &Language::TypeScript);
        let call_refs: Vec<_> = refs
            .iter()
            .filter(|r| matches!(r.kind, RawRefKind::FunctionCall) && r.name == "bar")
            .collect();
        assert!(
            !call_refs.is_empty(),
            "expected FunctionCall reference for 'bar'"
        );
    }

    // -- Rust tests --

    #[test]
    fn test_extract_rust_function() {
        let (nodes, _) = extract("fn foo() {}", &Language::Rust);
        let block = find_block(&nodes, "foo");
        if let CodeNode::CodeBlock { kind, .. } = block {
            assert_eq!(*kind, BlockKind::Function);
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_rust_pub_function() {
        let (nodes, _) = extract("pub fn foo() {}", &Language::Rust);
        let block = find_block(&nodes, "foo");
        if let CodeNode::CodeBlock { visibility, .. } = block {
            assert_eq!(*visibility, Some(Visibility::Public));
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_rust_struct() {
        let (nodes, _) = extract("struct Foo {}", &Language::Rust);
        let block = find_block(&nodes, "Foo");
        if let CodeNode::CodeBlock { kind, .. } = block {
            assert_eq!(*kind, BlockKind::Struct);
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_rust_enum() {
        let (nodes, _) = extract("enum Foo {}", &Language::Rust);
        let block = find_block(&nodes, "Foo");
        if let CodeNode::CodeBlock { kind, .. } = block {
            assert_eq!(*kind, BlockKind::Enum);
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_rust_trait() {
        let (nodes, _) = extract("trait Foo {}", &Language::Rust);
        let block = find_block(&nodes, "Foo");
        if let CodeNode::CodeBlock { kind, .. } = block {
            assert_eq!(*kind, BlockKind::Trait);
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_rust_impl() {
        let (nodes, _) = extract("impl Foo { fn bar() {} }", &Language::Rust);
        let impl_block = find_block_by_kind(&nodes, &BlockKind::Impl);
        if let CodeNode::CodeBlock { name, kind, .. } = impl_block {
            assert_eq!(*kind, BlockKind::Impl);
            assert!(
                name.contains("Foo"),
                "impl block name should contain 'Foo', got '{}'",
                name
            );
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_rust_trait_impl() {
        let (nodes, _) = extract("impl Trait for Foo {}", &Language::Rust);
        let impl_block = find_block_by_kind(&nodes, &BlockKind::Impl);
        if let CodeNode::CodeBlock { name, .. } = impl_block {
            assert!(
                name.contains("Trait for Foo"),
                "trait impl name should contain 'Trait for Foo', got '{}'",
                name
            );
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_rust_mod() {
        let (nodes, _) = extract("mod foo {}", &Language::Rust);
        let block = find_block(&nodes, "foo");
        if let CodeNode::CodeBlock { kind, .. } = block {
            assert_eq!(*kind, BlockKind::Module);
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_rust_const() {
        let (nodes, _) = extract("const FOO: i32 = 1;", &Language::Rust);
        let block = find_block(&nodes, "FOO");
        if let CodeNode::CodeBlock { kind, .. } = block {
            assert_eq!(*kind, BlockKind::Constant);
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_extract_rust_type_alias() {
        let (nodes, _) = extract("type Foo = Bar;", &Language::Rust);
        let block = find_block(&nodes, "Foo");
        if let CodeNode::CodeBlock { kind, .. } = block {
            assert_eq!(*kind, BlockKind::TypeAlias);
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_rust_use_full_paths_and_lists() {
        // Full module paths are preserved so the import resolver can map them
        // to files; the ref name is the last path segment.
        let source = "use crate::model::CodeGraph;";
        let (_, refs) = extract(source, &Language::Rust);
        let imports: Vec<_> = refs
            .iter()
            .filter_map(|r| match &r.kind {
                RawRefKind::Import { module_path } => Some((module_path.as_str(), r.name.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(imports, vec![("crate::model::CodeGraph", "CodeGraph")]);

        // Use lists expand into one ref per leaf, aliases resolve to the
        // original path, and `self` maps to the module itself.
        let source_list =
            "use crate::model::{graph, edge as E};\nuse super::util::{self, helpers};";
        let (_, refs_list) = extract(source_list, &Language::Rust);
        let mut paths: Vec<String> = refs_list
            .iter()
            .filter_map(|r| match &r.kind {
                RawRefKind::Import { module_path } => Some(module_path.clone()),
                _ => None,
            })
            .collect();
        paths.sort();
        assert_eq!(
            paths,
            vec![
                "crate::model::edge",
                "crate::model::graph",
                "super::util",
                "super::util::helpers",
            ]
        );

        // Wildcards import the module itself.
        let source_glob = "use crate::model::*;";
        let (_, refs_glob) = extract(source_glob, &Language::Rust);
        let glob_paths: Vec<_> = refs_glob
            .iter()
            .filter_map(|r| match &r.kind {
                RawRefKind::Import { module_path } => Some(module_path.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(glob_paths, vec!["crate::model"]);
    }

    #[test]
    fn test_extract_rust_use() {
        // use declarations inside a module or function body are collected
        let source = "mod setup {\n    use std::collections::HashMap;\n}";
        let (_, refs) = extract(source, &Language::Rust);
        let import_refs: Vec<_> = refs
            .iter()
            .filter(|r| matches!(&r.kind, RawRefKind::Import { .. }))
            .collect();
        assert!(
            !import_refs.is_empty(),
            "expected at least one import reference inside mod"
        );
        // The extracted name should be "HashMap" (last identifier in use path)
        assert!(
            import_refs.iter().any(|r| r.name == "HashMap"),
            "expected import ref with name 'HashMap'"
        );

        // Top-level use declarations are attributed to the file NodeId.
        let source_top = "use std::collections::HashMap;";
        let (_, refs_top) = extract(source_top, &Language::Rust);
        let top_imports: Vec<_> = refs_top
            .iter()
            .filter(|r| matches!(&r.kind, RawRefKind::Import { .. }))
            .collect();
        assert!(
            !top_imports.is_empty(),
            "top-level use should produce Import refs"
        );
        let file_id = NodeId::file("test.file");
        assert!(
            top_imports.iter().all(|r| r.from_node == file_id),
            "top-level use should be attributed to the file NodeId"
        );
        assert!(
            top_imports.iter().any(|r| r.name == "HashMap"),
            "expected top-level import ref with name 'HashMap'"
        );
    }

    #[test]
    fn test_ts_inheritance() {
        let source = "class Foo extends Bar {}";
        let (_, refs) = extract(source, &Language::TypeScript);

        let inherit_refs = refs_of_kind(&refs, |k| matches!(k, RawRefKind::Inheritance));
        assert!(
            inherit_refs.iter().any(|r| r.name == "Bar"),
            "expected Inheritance reference to 'Bar', got: {:?}",
            inherit_refs.iter().map(|r| &r.name).collect::<Vec<_>>()
        );
    }

    // -- F4: TraitImpl tests --

    #[test]
    fn test_rust_trait_impl() {
        let source = "impl Display for Foo {}";
        let (_, refs) = extract(source, &Language::Rust);

        let trait_refs = refs_of_kind(&refs, |k| matches!(k, RawRefKind::TraitImpl));
        assert!(
            trait_refs.iter().any(|r| r.name == "Display"),
            "expected TraitImpl reference to 'Display', got: {:?}",
            trait_refs.iter().map(|r| &r.name).collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_extract_rust_call() {
        let source = "fn foo() { bar(); }";
        let (_, refs) = extract(source, &Language::Rust);
        let call_refs: Vec<_> = refs
            .iter()
            .filter(|r| matches!(r.kind, RawRefKind::FunctionCall) && r.name == "bar")
            .collect();
        assert!(
            !call_refs.is_empty(),
            "expected FunctionCall reference for 'bar'"
        );
    }

    // -- Edge cases --

    #[test]
    fn test_extract_empty_file() {
        for lang in &[
            Language::Python,
            Language::TypeScript,
            Language::JavaScript,
            Language::Rust,
        ] {
            let (nodes, refs) = extract("", lang);
            assert!(
                nodes.is_empty(),
                "empty source for {:?} should produce no nodes",
                lang
            );
            assert!(
                refs.is_empty(),
                "empty source for {:?} should produce no refs",
                lang
            );
        }
    }

    // -- Innermost attribution / children hierarchy --

    fn block_id_of(nodes: &[CodeNode], name: &str) -> NodeId {
        if let CodeNode::CodeBlock { id, .. } = find_block(nodes, name) {
            id.clone()
        } else {
            panic!("expected CodeBlock for '{}'", name);
        }
    }

    #[test]
    fn test_method_body_call_attributed_to_method_not_class() {
        // A class with a method whose body calls bar(): the FunctionCall ref must
        // be attributed to the method block exactly once, never the class or file.
        let source = "class Foo:\n    def m(self):\n        bar()";
        let (nodes, refs) = extract(source, &Language::Python);

        let method_id = block_id_of(&nodes, "m");
        let class_id = block_id_of(&nodes, "Foo");
        let file_id = NodeId::file("test.file");

        let bar_calls: Vec<_> = refs
            .iter()
            .filter(|r| matches!(r.kind, RawRefKind::FunctionCall) && r.name == "bar")
            .collect();
        assert_eq!(
            bar_calls.len(),
            1,
            "expected exactly one FunctionCall ref for 'bar', got {}",
            bar_calls.len()
        );
        assert_eq!(
            bar_calls[0].from_node, method_id,
            "bar() should be attributed to the method block"
        );
        assert_ne!(bar_calls[0].from_node, class_id, "not the class");
        assert_ne!(bar_calls[0].from_node, file_id, "not the file");
    }

    #[test]
    fn test_class_children_contains_method() {
        let source = "class Foo:\n    def bar(self):\n        pass";
        let (nodes, _) = extract(source, &Language::Python);

        let method_id = block_id_of(&nodes, "bar");
        if let CodeNode::CodeBlock { children, .. } = find_block(&nodes, "Foo") {
            assert!(
                children.contains(&method_id),
                "class children should contain the method id, got {:?}",
                children
            );
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_only_top_level_blocks_parented_to_file() {
        // The class is top-level (parent == file); the method is nested
        // (parent == class). Extract-level check of the parent links that
        // parse_repo uses to build the File node's children.
        let source = "class Foo:\n    def bar(self):\n        pass";
        let (nodes, _) = extract(source, &Language::Python);
        let file_id = NodeId::file("test.file");

        let class = find_block(&nodes, "Foo");
        let method = find_block(&nodes, "bar");
        let class_id = block_id_of(&nodes, "Foo");

        if let CodeNode::CodeBlock { parent, .. } = class {
            assert_eq!(*parent, file_id, "class parent should be the file");
        }
        if let CodeNode::CodeBlock { parent, .. } = method {
            assert_eq!(*parent, class_id, "method parent should be the class");
        }

        // Blocks whose parent is the file (these become File node children).
        let file_children: Vec<&str> = nodes
            .iter()
            .filter_map(|n| match n {
                CodeNode::CodeBlock { name, parent, .. } if *parent == file_id => {
                    Some(name.as_str())
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            file_children,
            vec!["Foo"],
            "only the top-level class should be parented to the file"
        );
    }

    #[test]
    fn test_extract_signature() {
        // Python function: signature should be the first line
        let (nodes, _) = extract("def foo():\n    pass", &Language::Python);
        let block = find_block(&nodes, "foo");
        if let CodeNode::CodeBlock { signature, .. } = block {
            let sig = signature.as_ref().expect("signature should be present");
            assert_eq!(sig, "def foo():");
        } else {
            panic!("expected CodeBlock");
        }

        // Rust function
        let (nodes, _) = extract("fn bar() {\n    42\n}", &Language::Rust);
        let block = find_block(&nodes, "bar");
        if let CodeNode::CodeBlock { signature, .. } = block {
            let sig = signature.as_ref().expect("signature should be present");
            assert_eq!(sig, "fn bar() {");
        } else {
            panic!("expected CodeBlock");
        }

        // TypeScript function
        let (nodes, _) = extract("function baz() {\n    return 1;\n}", &Language::TypeScript);
        let block = find_block(&nodes, "baz");
        if let CodeNode::CodeBlock { signature, .. } = block {
            let sig = signature.as_ref().expect("signature should be present");
            assert_eq!(sig, "function baz() {");
        } else {
            panic!("expected CodeBlock");
        }
    }
}
