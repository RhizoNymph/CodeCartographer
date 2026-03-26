use tree_sitter::Node;

use crate::model::{BlockKind, NodeId, Visibility};

use super::extract::{RawRefKind, RawReference};
use super::language::LanguageSupport;
use super::extract::Extractor;

/// TypeScript language support for code classification and reference collection.
pub struct TypeScriptSupport;

impl LanguageSupport for TypeScriptSupport {
    fn classify_node(
        &self,
        kind: &str,
        node: &Node,
        source: &str,
    ) -> Option<(BlockKind, String, Option<Visibility>)> {
        classify_ts_js(kind, node, source)
    }

    fn collect_references(
        &self,
        source: &str,
        root: &Node,
        from_id: &NodeId,
        refs: &mut Vec<RawReference>,
    ) {
        collect_ts_js_references(source, root, from_id, refs);
    }

    fn tree_sitter_language(&self) -> tree_sitter::Language {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
    }
}

/// JavaScript language support. Reuses TypeScript classification and reference
/// collection logic but uses the JavaScript tree-sitter grammar.
pub struct JavaScriptSupport;

impl LanguageSupport for JavaScriptSupport {
    fn classify_node(
        &self,
        kind: &str,
        node: &Node,
        source: &str,
    ) -> Option<(BlockKind, String, Option<Visibility>)> {
        classify_ts_js(kind, node, source)
    }

    fn collect_references(
        &self,
        source: &str,
        root: &Node,
        from_id: &NodeId,
        refs: &mut Vec<RawReference>,
    ) {
        collect_ts_js_references(source, root, from_id, refs);
    }

    fn tree_sitter_language(&self) -> tree_sitter::Language {
        tree_sitter_javascript::LANGUAGE.into()
    }
}

/// Shared classification logic for TypeScript and JavaScript.
fn classify_ts_js(
    kind: &str,
    node: &Node,
    source: &str,
) -> Option<(BlockKind, String, Option<Visibility>)> {
    match kind {
        "function_declaration" => {
            let name = Extractor::child_text(node, "name", source)?;
            Some((BlockKind::Function, name, Some(Visibility::Public)))
        }
        "class_declaration" => {
            let name = Extractor::child_text(node, "name", source)?;
            Some((BlockKind::Class, name, Some(Visibility::Public)))
        }
        "interface_declaration" => {
            let name = Extractor::child_text(node, "name", source)?;
            Some((BlockKind::Interface, name, Some(Visibility::Public)))
        }
        "type_alias_declaration" => {
            let name = Extractor::child_text(node, "name", source)?;
            Some((BlockKind::TypeAlias, name, Some(Visibility::Public)))
        }
        "enum_declaration" => {
            let name = Extractor::child_text(node, "name", source)?;
            Some((BlockKind::Enum, name, Some(Visibility::Public)))
        }
        "method_definition" => {
            let name = Extractor::child_text(node, "name", source)?;
            Some((BlockKind::Function, name, Some(Visibility::Public)))
        }
        "arrow_function" | "function_expression" => {
            if let Some(parent) = node.parent() {
                if parent.kind() == "variable_declarator" {
                    let name = Extractor::child_text(&parent, "name", source)?;
                    return Some((BlockKind::Function, name, Some(Visibility::Public)));
                }
            }
            None
        }
        _ => None,
    }
}

/// Shared reference collection logic for TypeScript and JavaScript.
fn collect_ts_js_references(
    source: &str,
    root: &Node,
    from_id: &NodeId,
    refs: &mut Vec<RawReference>,
) {
    let mut stack = vec![*root];

    while let Some(current) = stack.pop() {
        let kind = current.kind();

        match kind {
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
                            span: Extractor::node_span(&current),
                        });
                    }
                }
            }
            "call_expression" => {
                if let Some(func) = current.child_by_field_name("function") {
                    if func.kind() == "member_expression" {
                        let name = Extractor::extract_function_name(&func, source);
                        if !name.is_empty() {
                            refs.push(RawReference {
                                from_node: from_id.clone(),
                                kind: RawRefKind::MethodCall,
                                name,
                                span: Extractor::node_span(&current),
                            });
                        }
                    } else {
                        let name = Extractor::extract_function_name(&func, source);
                        if !name.is_empty() {
                            refs.push(RawReference {
                                from_node: from_id.clone(),
                                kind: RawRefKind::FunctionCall,
                                name,
                                span: Extractor::node_span(&current),
                            });
                        }
                    }
                }
            }
            "type_identifier" => {
                if let Ok(text) = current.utf8_text(source.as_bytes()) {
                    let name = text.trim().to_string();
                    if !name.is_empty() {
                        refs.push(RawReference {
                            from_node: from_id.clone(),
                            kind: RawRefKind::TypeReference,
                            name,
                            span: Extractor::node_span(&current),
                        });
                    }
                }
            }
            "extends_clause" => {
                let mut cursor = current.walk();
                for child in current.children(&mut cursor) {
                    if child.kind() == "identifier" || child.kind() == "type_identifier" {
                        if let Ok(text) = child.utf8_text(source.as_bytes()) {
                            refs.push(RawReference {
                                from_node: from_id.clone(),
                                kind: RawRefKind::Inheritance,
                                name: text.to_string(),
                                span: Extractor::node_span(&child),
                            });
                        }
                    }
                }
            }
            _ => {}
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
