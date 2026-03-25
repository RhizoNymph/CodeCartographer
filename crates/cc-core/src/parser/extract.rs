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

            // TODO: VariableUsage requires name resolution context not available
            // during first-pass parsing. It would need a symbol table to distinguish
            // variable references from other identifiers.

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
                            if func.kind() == "attribute" {
                                // Method call: obj.method()
                                // Extract the method name (last identifier after .)
                                let name = Self::extract_function_name(&func, source);
                                if !name.is_empty() {
                                    refs.push(RawReference {
                                        from_node: from_id.clone(),
                                        kind: RawRefKind::MethodCall,
                                        name,
                                        span: Self::node_span(&current),
                                    });
                                }
                            } else {
                                // Regular function call
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
                    }
                    "type" => {
                        // Type annotations in function parameters and return types
                        if let Ok(text) = current.utf8_text(source.as_bytes()) {
                            let name = text.trim().to_string();
                            if !name.is_empty() && !Self::is_python_builtin_type(&name) {
                                refs.push(RawReference {
                                    from_node: from_id.clone(),
                                    kind: RawRefKind::TypeReference,
                                    name,
                                    span: Self::node_span(&current),
                                });
                            }
                        }
                    }
                    "argument_list" => {
                        // Check if this is a superclass list in a class definition
                        if let Some(parent) = current.parent() {
                            if parent.kind() == "class_definition" {
                                let mut cursor = current.walk();
                                for child in current.children(&mut cursor) {
                                    if child.kind() == "identifier" {
                                        if let Ok(text) = child.utf8_text(source.as_bytes()) {
                                            refs.push(RawReference {
                                                from_node: from_id.clone(),
                                                kind: RawRefKind::Inheritance,
                                                name: text.to_string(),
                                                span: Self::node_span(&child),
                                            });
                                        }
                                    }
                                }
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
                            if func.kind() == "member_expression" {
                                // Method call: obj.method()
                                // Extract property name from member_expression
                                let name = Self::extract_function_name(&func, source);
                                if !name.is_empty() {
                                    refs.push(RawReference {
                                        from_node: from_id.clone(),
                                        kind: RawRefKind::MethodCall,
                                        name,
                                        span: Self::node_span(&current),
                                    });
                                }
                            } else {
                                // Regular function call
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
                    }
                    "type_identifier" => {
                        // Custom type references (not predefined_type like number, string)
                        if let Ok(text) = current.utf8_text(source.as_bytes()) {
                            let name = text.trim().to_string();
                            if !name.is_empty() {
                                refs.push(RawReference {
                                    from_node: from_id.clone(),
                                    kind: RawRefKind::TypeReference,
                                    name,
                                    span: Self::node_span(&current),
                                });
                            }
                        }
                    }
                    "extends_clause" => {
                        // class Foo extends Bar
                        let mut cursor = current.walk();
                        for child in current.children(&mut cursor) {
                            if child.kind() == "identifier" || child.kind() == "type_identifier" {
                                if let Ok(text) = child.utf8_text(source.as_bytes()) {
                                    refs.push(RawReference {
                                        from_node: from_id.clone(),
                                        kind: RawRefKind::Inheritance,
                                        name: text.to_string(),
                                        span: Self::node_span(&child),
                                    });
                                }
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
                            if func.kind() == "field_expression" {
                                // Method call: self.method() or foo.bar()
                                let name = Self::extract_function_name(&func, source);
                                if !name.is_empty() && name != "Self" && name != "self" {
                                    refs.push(RawReference {
                                        from_node: from_id.clone(),
                                        kind: RawRefKind::MethodCall,
                                        name,
                                        span: Self::node_span(&current),
                                    });
                                }
                            } else {
                                // Regular function call or path call (Vec::new())
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
                    }
                    "type_identifier" => {
                        // Type references in function parameters, return types, struct fields
                        // Skip common primitive types that won't resolve
                        if let Ok(text) = current.utf8_text(source.as_bytes()) {
                            let name = text.trim().to_string();
                            if !name.is_empty() && !Self::is_rust_builtin_type(&name) {
                                refs.push(RawReference {
                                    from_node: from_id.clone(),
                                    kind: RawRefKind::TypeReference,
                                    name,
                                    span: Self::node_span(&current),
                                });
                            }
                        }
                    }
                    "impl_item" => {
                        // Extract trait name from `impl Trait for Type`
                        if let Some(trait_node) = current.child_by_field_name("trait") {
                            if let Ok(text) = trait_node.utf8_text(source.as_bytes()) {
                                refs.push(RawReference {
                                    from_node: from_id.clone(),
                                    kind: RawRefKind::TraitImpl,
                                    name: text.to_string(),
                                    span: Self::node_span(&trait_node),
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

    /// Check if a Rust type name is a primitive that won't resolve to a user symbol.
    fn is_rust_builtin_type(name: &str) -> bool {
        matches!(
            name,
            "i8" | "i16"
                | "i32"
                | "i64"
                | "i128"
                | "isize"
                | "u8"
                | "u16"
                | "u32"
                | "u64"
                | "u128"
                | "usize"
                | "f32"
                | "f64"
                | "bool"
                | "char"
                | "str"
        )
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
    use crate::model::Language;

    // ── Helpers ──────────────────────────────────────────────────────

    fn extract(source: &str, lang: &Language) -> (Vec<CodeNode>, Vec<RawReference>) {
        Extractor::extract_file("test.file", source, lang).expect("extraction should succeed")
    }

    fn refs_of_kind(
        refs: &[RawReference],
        kind_match: fn(&RawRefKind) -> bool,
    ) -> Vec<&RawReference> {
        refs.iter().filter(|r| kind_match(&r.kind)).collect()
    }

    // ── F1: MethodCall tests ─────────────────────────────────────────

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

    // ── F2: TypeReference tests ──────────────────────────────────────

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

    // ── F3: Inheritance tests ────────────────────────────────────────

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

    // ── F4: TraitImpl tests ──────────────────────────────────────────

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
}
