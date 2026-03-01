use crate::model::{CodeEdge, CodeGraph, EdgeKind};
use crate::parser::{RawRefKind, RawReference};

use super::SymbolTable;

/// Resolves type references, inheritance, and trait implementations.
pub struct TypeResolver;

impl TypeResolver {
    pub fn resolve(
        _graph: &CodeGraph,
        symbol_table: &SymbolTable,
        refs: &[RawReference],
    ) -> Vec<CodeEdge> {
        let mut edges = Vec::new();

        for raw_ref in refs {
            let kind = match &raw_ref.kind {
                RawRefKind::TypeReference => EdgeKind::TypeReference,
                RawRefKind::Inheritance => EdgeKind::Inheritance,
                RawRefKind::TraitImpl => EdgeKind::TraitImpl,
                _ => continue,
            };

            // Look up the type name
            let lookup_name = raw_ref.name.as_str();

            // Strip generic parameters: Foo<Bar> -> Foo
            let lookup_name = if let Some(idx) = lookup_name.find('<') {
                &lookup_name[..idx]
            } else {
                lookup_name
            };

            // Strip path prefix: std::collections::HashMap -> HashMap
            let simple_name = lookup_name.rsplit("::").next().unwrap_or(lookup_name);

            if let Some(targets) = symbol_table
                .symbols
                .get(simple_name)
                .or_else(|| symbol_table.symbols.get(lookup_name))
            {
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
