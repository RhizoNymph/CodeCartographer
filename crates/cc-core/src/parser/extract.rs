use crate::model::{
    BlockKind, CodeNode, Language, NodeId, Span, Visibility,
};

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
    FileStart { path: String },
    FileDone { path: String, blocks: usize },
    Error { path: String, message: String },
    Complete { total_files: usize, total_blocks: usize },
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
            Language::TypeScript | Language::JavaScript => {
                let lang = tree_sitter_typescript::LANGUAGE_TYPESCRIPT;
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

    fn rust_visibility(
        node: &tree_sitter::Node,
        _source: &str,
    ) -> Option<Visibility> {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "visibility_modifier" {
                return Some(Visibility::Public);
            }
        }
        Some(Visibility::Private)
    }

    fn child_text(
        node: &tree_sitter::Node,
        field: &str,
        source: &str,
    ) -> Option<String> {
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
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            let kind = child.kind();
            match language {
                Language::Python => {
                    match kind {
                        "import_statement" | "import_from_statement" => {
                            if let Some(module) =
                                child.child_by_field_name("module_name")
                                    .or_else(|| child.child_by_field_name("name"))
                            {
                                if let Ok(text) = module.utf8_text(source.as_bytes()) {
                                    refs.push(RawReference {
                                        from_node: from_id.clone(),
                                        kind: RawRefKind::Import {
                                            module_path: text.to_string(),
                                        },
                                        name: text.to_string(),
                                        span: Span {
                                            start_line: child.start_position().row + 1,
                                            start_col: child.start_position().column,
                                            end_line: child.end_position().row + 1,
                                            end_col: child.end_position().column,
                                        },
                                    });
                                }
                            }
                        }
                        "call" => {
                            if let Some(func) = child.child_by_field_name("function") {
                                if let Ok(text) = func.utf8_text(source.as_bytes()) {
                                    refs.push(RawReference {
                                        from_node: from_id.clone(),
                                        kind: RawRefKind::FunctionCall,
                                        name: text.to_string(),
                                        span: Span {
                                            start_line: child.start_position().row + 1,
                                            start_col: child.start_position().column,
                                            end_line: child.end_position().row + 1,
                                            end_col: child.end_position().column,
                                        },
                                    });
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Language::TypeScript | Language::JavaScript => {
                    match kind {
                        "import_statement" => {
                            if let Some(src) = child.child_by_field_name("source") {
                                if let Ok(text) = src.utf8_text(source.as_bytes()) {
                                    let clean = text.trim_matches(|c| c == '\'' || c == '"');
                                    refs.push(RawReference {
                                        from_node: from_id.clone(),
                                        kind: RawRefKind::Import {
                                            module_path: clean.to_string(),
                                        },
                                        name: clean.to_string(),
                                        span: Span {
                                            start_line: child.start_position().row + 1,
                                            start_col: child.start_position().column,
                                            end_line: child.end_position().row + 1,
                                            end_col: child.end_position().column,
                                        },
                                    });
                                }
                            }
                        }
                        "call_expression" => {
                            if let Some(func) = child.child_by_field_name("function") {
                                if let Ok(text) = func.utf8_text(source.as_bytes()) {
                                    refs.push(RawReference {
                                        from_node: from_id.clone(),
                                        kind: RawRefKind::FunctionCall,
                                        name: text.to_string(),
                                        span: Span {
                                            start_line: child.start_position().row + 1,
                                            start_col: child.start_position().column,
                                            end_line: child.end_position().row + 1,
                                            end_col: child.end_position().column,
                                        },
                                    });
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Language::Rust => {
                    match kind {
                        "use_declaration" => {
                            if let Ok(text) = child.utf8_text(source.as_bytes()) {
                                refs.push(RawReference {
                                    from_node: from_id.clone(),
                                    kind: RawRefKind::Import {
                                        module_path: text.to_string(),
                                    },
                                    name: text.to_string(),
                                    span: Span {
                                        start_line: child.start_position().row + 1,
                                        start_col: child.start_position().column,
                                        end_line: child.end_position().row + 1,
                                        end_col: child.end_position().column,
                                    },
                                });
                            }
                        }
                        "call_expression" => {
                            if let Some(func) = child.child_by_field_name("function") {
                                if let Ok(text) = func.utf8_text(source.as_bytes()) {
                                    refs.push(RawReference {
                                        from_node: from_id.clone(),
                                        kind: RawRefKind::FunctionCall,
                                        name: text.to_string(),
                                        span: Span {
                                            start_line: child.start_position().row + 1,
                                            start_col: child.start_position().column,
                                            end_line: child.end_position().row + 1,
                                            end_col: child.end_position().column,
                                        },
                                    });
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}
