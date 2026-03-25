use crate::model::{BlockKind, CodeNode, Language, NodeId, Span, Visibility};

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
    Import { module_path: String },
    FunctionCall,
    MethodCall,
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
        let mut parser = tree_sitter::Parser::new();

        match language {
            Language::Python => {
                let lang = tree_sitter_python::LANGUAGE;
                parser.set_language(&lang.into())?;
            }
            Language::TypeScript => {
                let lang = tree_sitter_typescript::LANGUAGE_TYPESCRIPT;
                parser.set_language(&lang.into())?;
            }
            Language::JavaScript => {
                let lang = tree_sitter_javascript::LANGUAGE;
                parser.set_language(&lang.into())?;
            }
            Language::Rust => {
                let lang = tree_sitter_rust::LANGUAGE;
                parser.set_language(&lang.into())?;
            }
        }

        let tree = parser
            .parse(source, None)
            .ok_or_else(|| anyhow::anyhow!("Failed to parse {}", file_path))?;

        let mut nodes = Vec::new();
        let mut refs = Vec::new();

        Self::walk_tree(
            file_path,
            source,
            language,
            &tree.root_node(),
            &NodeId::file(file_path),
            &mut nodes,
            &mut refs,
        );

        Ok((nodes, refs))
    }

    fn walk_tree(
        file_path: &str,
        source: &str,
        language: &Language,
        node: &tree_sitter::Node,
        parent_id: &NodeId,
        out_nodes: &mut Vec<CodeNode>,
        out_refs: &mut Vec<RawReference>,
    ) {
        let kind = node.kind();

        if let Some((block_kind, name, visibility)) =
            Self::classify_node(kind, node, source, language)
        {
            let span = Span {
                start_line: node.start_position().row + 1,
                start_col: node.start_position().column,
                end_line: node.end_position().row + 1,
                end_col: node.end_position().column,
            };

            let signature = Self::extract_signature(node, source, language);

            let block_id = NodeId::code_block(file_path, &name, span.start_line);

            out_nodes.push(CodeNode::CodeBlock {
                id: block_id.clone(),
                name,
                kind: block_kind,
                span,
                signature,
                visibility,
                parent: parent_id.clone(),
                children: Vec::new(),
            });

            // Recurse with this block as parent
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                Self::walk_tree(
                    file_path, source, language, &child, &block_id, out_nodes, out_refs,
                );
            }

            // Collect references
            Self::collect_references(file_path, source, language, node, &block_id, out_refs);
        } else {
            // Not a code block, recurse normally
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                Self::walk_tree(
                    file_path, source, language, &child, parent_id, out_nodes, out_refs,
                );
            }
        }
    }

    fn classify_node(
        kind: &str,
        node: &tree_sitter::Node,
        source: &str,
        language: &Language,
    ) -> Option<(BlockKind, String, Option<Visibility>)> {
        match language {
            Language::Python => Self::classify_python(kind, node, source),
            Language::TypeScript | Language::JavaScript => {
                Self::classify_typescript(kind, node, source)
            }
            Language::Rust => Self::classify_rust(kind, node, source),
        }
    }

    fn classify_python(
        kind: &str,
        node: &tree_sitter::Node,
        source: &str,
    ) -> Option<(BlockKind, String, Option<Visibility>)> {
        match kind {
            "function_definition" => {
                let name = Self::child_text(node, "name", source)?;
                let vis = if name.starts_with('_') {
                    Some(Visibility::Private)
                } else {
                    Some(Visibility::Public)
                };
                Some((BlockKind::Function, name, vis))
            }
            "class_definition" => {
                let name = Self::child_text(node, "name", source)?;
                Some((BlockKind::Class, name, Some(Visibility::Public)))
            }
            _ => None,
        }
    }

    fn classify_typescript(
        kind: &str,
        node: &tree_sitter::Node,
        source: &str,
    ) -> Option<(BlockKind, String, Option<Visibility>)> {
        match kind {
            "function_declaration" => {
                let name = Self::child_text(node, "name", source)?;
                Some((BlockKind::Function, name, Some(Visibility::Public)))
            }
            "class_declaration" => {
                let name = Self::child_text(node, "name", source)?;
                Some((BlockKind::Class, name, Some(Visibility::Public)))
            }
            "interface_declaration" => {
                let name = Self::child_text(node, "name", source)?;
                Some((BlockKind::Interface, name, Some(Visibility::Public)))
            }
            "type_alias_declaration" => {
                let name = Self::child_text(node, "name", source)?;
                Some((BlockKind::TypeAlias, name, Some(Visibility::Public)))
            }
            "enum_declaration" => {
                let name = Self::child_text(node, "name", source)?;
                Some((BlockKind::Enum, name, Some(Visibility::Public)))
            }
            "method_definition" => {
                let name = Self::child_text(node, "name", source)?;
                Some((BlockKind::Function, name, Some(Visibility::Public)))
            }
            "arrow_function" | "function_expression" => {
                // Check if it's assigned to a variable
                if let Some(parent) = node.parent() {
                    if parent.kind() == "variable_declarator" {
                        let name = Self::child_text(&parent, "name", source)?;
                        return Some((BlockKind::Function, name, Some(Visibility::Public)));
                    }
                }
                None
            }
            _ => None,
        }
    }

    fn classify_rust(
        kind: &str,
        node: &tree_sitter::Node,
        source: &str,
    ) -> Option<(BlockKind, String, Option<Visibility>)> {
        let vis = Self::rust_visibility(node, source);

        match kind {
            "function_item" => {
                let name = Self::child_text(node, "name", source)?;
                Some((BlockKind::Function, name, vis))
            }
            "struct_item" => {
                let name = Self::child_text(node, "name", source)?;
                Some((BlockKind::Struct, name, vis))
            }
            "enum_item" => {
                let name = Self::child_text(node, "name", source)?;
                Some((BlockKind::Enum, name, vis))
            }
            "trait_item" => {
                let name = Self::child_text(node, "name", source)?;
                Some((BlockKind::Trait, name, vis))
            }
            "impl_item" => {
                // Get the type name being implemented
                let type_node = node.child_by_field_name("type");
                let trait_node = node.child_by_field_name("trait");
                let name = match (trait_node, type_node) {
                    (Some(t), Some(ty)) => {
                        format!(
                            "{} for {}",
                            t.utf8_text(source.as_bytes()).unwrap_or("?"),
                            ty.utf8_text(source.as_bytes()).unwrap_or("?")
                        )
                    }
                    (None, Some(ty)) => {
                        format!("impl {}", ty.utf8_text(source.as_bytes()).unwrap_or("?"))
                    }
                    _ => "impl".to_string(),
                };
                Some((BlockKind::Impl, name, vis))
            }
            "mod_item" => {
                let name = Self::child_text(node, "name", source)?;
                Some((BlockKind::Module, name, vis))
            }
            "const_item" | "static_item" => {
                let name = Self::child_text(node, "name", source)?;
                Some((BlockKind::Constant, name, vis))
            }
            "type_item" => {
                let name = Self::child_text(node, "name", source)?;
                Some((BlockKind::TypeAlias, name, vis))
            }
            _ => None,
        }
    }

    fn rust_visibility(node: &tree_sitter::Node, _source: &str) -> Option<Visibility> {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "visibility_modifier" {
                return Some(Visibility::Public);
            }
        }
        Some(Visibility::Private)
    }

    fn child_text(node: &tree_sitter::Node, field: &str, source: &str) -> Option<String> {
        node.child_by_field_name(field)
            .and_then(|n| n.utf8_text(source.as_bytes()).ok())
            .map(|s| s.to_string())
    }

    fn extract_signature(
        node: &tree_sitter::Node,
        source: &str,
        _language: &Language,
    ) -> Option<String> {
        // Take the first line of the node as a rough signature
        let text = node.utf8_text(source.as_bytes()).ok()?;
        let first_line = text.lines().next()?;
        Some(first_line.trim().to_string())
    }

    fn collect_references(
        _file_path: &str,
        source: &str,
        language: &Language,
        node: &tree_sitter::Node,
        from_id: &NodeId,
        refs: &mut Vec<RawReference>,
    ) {
        // Use a stack-based traversal to avoid issues with cursor invalidation
        let mut stack = vec![*node];

        while let Some(current) = stack.pop() {
            let kind = current.kind();

            match language {
                Language::Python => match kind {
                    "import_statement" | "import_from_statement" => {
                        if let Some(module) = current
                            .child_by_field_name("module_name")
                            .or_else(|| current.child_by_field_name("name"))
                        {
                            if let Ok(text) = module.utf8_text(source.as_bytes()) {
                                refs.push(RawReference {
                                    from_node: from_id.clone(),
                                    kind: RawRefKind::Import {
                                        module_path: text.to_string(),
                                    },
                                    name: text.to_string(),
                                    span: Self::node_span(&current),
                                });
                            }
                        }
                    }
                    "call" => {
                        if let Some(func) = current.child_by_field_name("function") {
                            let name = Self::extract_function_name(&func, source);
                            if !name.is_empty() {
                                refs.push(RawReference {
                                    from_node: from_id.clone(),
                                    kind: RawRefKind::FunctionCall,
                                    name,
                                    span: Self::node_span(&current),
                                });
                            }
                        }
                    }
                    _ => {}
                },
                Language::TypeScript | Language::JavaScript => match kind {
                    "import_statement" => {
                        if let Some(src) = current.child_by_field_name("source") {
                            if let Ok(text) = src.utf8_text(source.as_bytes()) {
                                let clean = text.trim_matches(|c| c == '\'' || c == '"');
                                refs.push(RawReference {
                                    from_node: from_id.clone(),
                                    kind: RawRefKind::Import {
                                        module_path: clean.to_string(),
                                    },
                                    name: clean.to_string(),
                                    span: Self::node_span(&current),
                                });
                            }
                        }
                    }
                    "call_expression" => {
                        if let Some(func) = current.child_by_field_name("function") {
                            let name = Self::extract_function_name(&func, source);
                            if !name.is_empty() {
                                refs.push(RawReference {
                                    from_node: from_id.clone(),
                                    kind: RawRefKind::FunctionCall,
                                    name,
                                    span: Self::node_span(&current),
                                });
                            }
                        }
                    }
                    _ => {}
                },
                Language::Rust => match kind {
                    "use_declaration" => {
                        if let Some(name) = Self::extract_use_name(&current, source) {
                            refs.push(RawReference {
                                from_node: from_id.clone(),
                                kind: RawRefKind::Import {
                                    module_path: name.clone(),
                                },
                                name,
                                span: Self::node_span(&current),
                            });
                        }
                    }
                    "call_expression" => {
                        if let Some(func) = current.child_by_field_name("function") {
                            let name = Self::extract_function_name(&func, source);
                            if !name.is_empty() && name != "Self" && name != "self" {
                                refs.push(RawReference {
                                    from_node: from_id.clone(),
                                    kind: RawRefKind::FunctionCall,
                                    name,
                                    span: Self::node_span(&current),
                                });
                            }
                        }
                    }
                    _ => {}
                },
            }

            // Push children onto stack
            let child_count = current.child_count();
            for i in 0..child_count {
                if let Some(child) = current.child(i) {
                    stack.push(child);
                }
            }
        }
    }

    fn node_span(node: &tree_sitter::Node) -> Span {
        Span {
            start_line: node.start_position().row + 1,
            start_col: node.start_position().column,
            end_line: node.end_position().row + 1,
            end_col: node.end_position().column,
        }
    }

    /// Extract the actual function name from a call expression.
    /// Handles: foo(), self.foo(), Self::foo(), module::foo(), obj.method()
    fn extract_function_name(node: &tree_sitter::Node, source: &str) -> String {
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

    /// Extract imported name from a use declaration
    fn extract_use_name(node: &tree_sitter::Node, source: &str) -> Option<String> {
        // Find the last identifier in the use path
        fn find_last_ident(n: &tree_sitter::Node, src: &str) -> Option<String> {
            if n.kind() == "identifier" {
                return n.utf8_text(src.as_bytes()).ok().map(|s| s.to_string());
            }
            let mut last = None;
            let child_count = n.child_count();
            for i in 0..child_count {
                if let Some(child) = n.child(i) {
                    if let Some(name) = find_last_ident(&child, src) {
                        last = Some(name);
                    }
                }
            }
            last
        }
        find_last_ident(node, source)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BlockKind, Language, Visibility};

    // ── Helpers ──────────────────────────────────────────────────────

    fn extract(source: &str, lang: &Language) -> (Vec<CodeNode>, Vec<RawReference>) {
        Extractor::extract_file("test.file", source, lang).expect("extraction should succeed")
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

    // ── Python tests ─────────────────────────────────────────────────

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
        // Import statements inside a function body are collected as references
        // (collect_references only runs on subtrees of classified code blocks)
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

        // Top-level imports are not inside any code block, so they are NOT collected
        let source_top = "import os\nfrom os import path";
        let (_, refs_top) = extract(source_top, &Language::Python);
        let top_imports: Vec<_> = refs_top
            .iter()
            .filter(|r| matches!(&r.kind, RawRefKind::Import { .. }))
            .collect();
        assert!(
            top_imports.is_empty(),
            "top-level imports produce no refs (no enclosing code block)"
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

    // ── TypeScript tests ─────────────────────────────────────────────

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
        // Top-level import statements are not inside any code block, so the
        // extractor does not collect them as references (collect_references only
        // runs for subtrees of classified blocks). Verify this expected behavior:
        let source_top = "import { foo } from './bar'";
        let (_, refs_top) = extract(source_top, &Language::TypeScript);
        let top_imports: Vec<_> = refs_top
            .iter()
            .filter(|r| matches!(&r.kind, RawRefKind::Import { .. }))
            .collect();
        // Top-level imports produce no refs in current implementation
        assert!(
            top_imports.is_empty(),
            "top-level imports are not collected as refs (no enclosing code block)"
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

    // ── Rust tests ───────────────────────────────────────────────────

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

        // Top-level use declarations produce no refs (no enclosing code block)
        let source_top = "use std::collections::HashMap;";
        let (_, refs_top) = extract(source_top, &Language::Rust);
        let top_imports: Vec<_> = refs_top
            .iter()
            .filter(|r| matches!(&r.kind, RawRefKind::Import { .. }))
            .collect();
        assert!(
            top_imports.is_empty(),
            "top-level use produces no refs (no enclosing code block)"
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

    // ── Edge cases ───────────────────────────────────────────────────

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
        let (nodes, _) = extract(
            "function baz() {\n    return 1;\n}",
            &Language::TypeScript,
        );
        let block = find_block(&nodes, "baz");
        if let CodeNode::CodeBlock { signature, .. } = block {
            let sig = signature.as_ref().expect("signature should be present");
            assert_eq!(sig, "function baz() {");
        } else {
            panic!("expected CodeBlock");
        }
    }
}
