use crate::model::{CodeEdge, CodeGraph, EdgeKind};
use crate::parser::{RawRefKind, RawReference};

use super::SymbolTable;

/// Resolves function/method calls to their definitions.
pub struct CallResolver;

impl CallResolver {
    pub fn resolve(
        _graph: &CodeGraph,
        symbol_table: &SymbolTable,
        refs: &[RawReference],
    ) -> Vec<CodeEdge> {
        let mut edges = Vec::new();

        for raw_ref in refs {
            let (kind, name) = match &raw_ref.kind {
                RawRefKind::FunctionCall => (EdgeKind::FunctionCall, &raw_ref.name),
                RawRefKind::MethodCall => (EdgeKind::MethodCall, &raw_ref.name),
                _ => continue,
            };

            // Strip method call receiver: "foo.bar()" -> look up "bar"
            let lookup_name = if name.contains('.') {
                name.rsplit('.').next().unwrap_or(name)
            } else {
                name.as_str()
            };

            // Strip module path: "module::func" -> look up "func"
            let lookup_name = if lookup_name.contains("::") {
                lookup_name.rsplit("::").next().unwrap_or(lookup_name)
            } else {
                lookup_name
            };

            if let Some(targets) = symbol_table.symbols.get(lookup_name) {
                for target in targets {
                    if *target != raw_ref.from_node {
                        edges.push(CodeEdge {
                            source: raw_ref.from_node.clone(),
                            target: target.clone(),
                            kind: kind.clone(),
                            weight: 1,
                        });
                    }
                }
            }
        }

        edges
    }
}
