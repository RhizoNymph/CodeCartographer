use tree_sitter::Node;

use crate::model::{BlockKind, NodeId, Visibility};

use super::extract::{RawRefKind, RawReference};
use super::language::LanguageSupport;
use super::extract::Extractor;

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
                let vis = if name.starts_with('_') {
                    Some(Visibility::Private)
                } else {
                    Some(Visibility::Public)
                };
                Some((BlockKind::Function, name, vis))
            }
            "class_definition" => {
                let name = Extractor::child_text(node, "name", source)?;
                Some((BlockKind::Class, name, Some(Visibility::Public)))
            }
            _ => None,
        }
    }

    fn collect_references(
        &self,
        source: &str,
        root: &Node,
        from_id: &NodeId,
        refs: &mut Vec<RawReference>,
    ) {
        let mut stack = vec![*root];

        while let Some(current) = stack.pop() {
            let kind = current.kind();

            match kind {
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
                                span: Extractor::node_span(&current),
                            });
                        }
                    }
                }
                "call" => {
                    if let Some(func) = current.child_by_field_name("function") {
                        if func.kind() == "attribute" {
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
                "type" => {
                    if let Ok(text) = current.utf8_text(source.as_bytes()) {
                        let name = text.trim().to_string();
                        if !name.is_empty() && !is_python_builtin_type(&name) {
                            refs.push(RawReference {
                                from_node: from_id.clone(),
                                kind: RawRefKind::TypeReference,
                                name,
                                span: Extractor::node_span(&current),
                            });
                        }
                    }
                }
                "argument_list" => {
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
                                            span: Extractor::node_span(&child),
                                        });
                                    }
                                }
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

    fn tree_sitter_language(&self) -> tree_sitter::Language {
        tree_sitter_python::LANGUAGE.into()
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
