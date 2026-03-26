use tree_sitter::Node;

use crate::model::{BlockKind, NodeId, Visibility};

use super::extract::{RawRefKind, RawReference};
use super::language::LanguageSupport;
use super::extract::Extractor;

/// Rust language support for code classification and reference collection.
pub struct RustSupport;

impl LanguageSupport for RustSupport {
    fn classify_node(
        &self,
        kind: &str,
        node: &Node,
        source: &str,
    ) -> Option<(BlockKind, String, Option<Visibility>)> {
        let vis = rust_visibility(node, source);

        match kind {
            "function_item" => {
                let name = Extractor::child_text(node, "name", source)?;
                Some((BlockKind::Function, name, vis))
            }
            "struct_item" => {
                let name = Extractor::child_text(node, "name", source)?;
                Some((BlockKind::Struct, name, vis))
            }
            "enum_item" => {
                let name = Extractor::child_text(node, "name", source)?;
                Some((BlockKind::Enum, name, vis))
            }
            "trait_item" => {
                let name = Extractor::child_text(node, "name", source)?;
                Some((BlockKind::Trait, name, vis))
            }
            "impl_item" => {
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
                let name = Extractor::child_text(node, "name", source)?;
                Some((BlockKind::Module, name, vis))
            }
            "const_item" | "static_item" => {
                let name = Extractor::child_text(node, "name", source)?;
                Some((BlockKind::Constant, name, vis))
            }
            "type_item" => {
                let name = Extractor::child_text(node, "name", source)?;
                Some((BlockKind::TypeAlias, name, vis))
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
                "use_declaration" => {
                    if let Some(name) = Extractor::extract_use_name(&current, source) {
                        refs.push(RawReference {
                            from_node: from_id.clone(),
                            kind: RawRefKind::Import {
                                module_path: name.clone(),
                            },
                            name,
                            span: Extractor::node_span(&current),
                        });
                    }
                }
                "call_expression" => {
                    if let Some(func) = current.child_by_field_name("function") {
                        if func.kind() == "field_expression" {
                            let name = Extractor::extract_function_name(&func, source);
                            if !name.is_empty() && name != "Self" && name != "self" {
                                refs.push(RawReference {
                                    from_node: from_id.clone(),
                                    kind: RawRefKind::MethodCall,
                                    name,
                                    span: Extractor::node_span(&current),
                                });
                            }
                        } else {
                            let name = Extractor::extract_function_name(&func, source);
                            if !name.is_empty() && name != "Self" && name != "self" {
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
                        if !name.is_empty() && !is_rust_builtin_type(&name) {
                            refs.push(RawReference {
                                from_node: from_id.clone(),
                                kind: RawRefKind::TypeReference,
                                name,
                                span: Extractor::node_span(&current),
                            });
                        }
                    }
                }
                "impl_item" => {
                    if let Some(trait_node) = current.child_by_field_name("trait") {
                        if let Ok(text) = trait_node.utf8_text(source.as_bytes()) {
                            refs.push(RawReference {
                                from_node: from_id.clone(),
                                kind: RawRefKind::TraitImpl,
                                name: text.to_string(),
                                span: Extractor::node_span(&trait_node),
                            });
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
        tree_sitter_rust::LANGUAGE.into()
    }
}

/// Improved visibility detection for Rust items. Inspects the visibility_modifier
/// text to distinguish pub, pub(crate), and pub(super).
fn rust_visibility(node: &tree_sitter::Node, source: &str) -> Option<Visibility> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "visibility_modifier" {
            let text = child.utf8_text(source.as_bytes()).unwrap_or("pub");
            return Some(if text == "pub" {
                Visibility::Public
            } else if text.contains("crate") {
                Visibility::Crate
            } else if text.contains("super") {
                Visibility::Protected
            } else {
                Visibility::Public
            });
        }
    }
    Some(Visibility::Private)
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
