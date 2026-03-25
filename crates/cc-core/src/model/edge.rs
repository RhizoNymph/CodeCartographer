use serde::{Deserialize, Serialize};

use super::NodeId;

/// The kind of relationship between two code nodes.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EdgeKind {
    Import,
    FunctionCall,
    MethodCall,
    TypeReference,
    Inheritance,
    TraitImpl,
    VariableUsage,
}

impl EdgeKind {
    pub fn color(&self) -> &str {
        match self {
            EdgeKind::Import => "#6366f1",        // indigo
            EdgeKind::FunctionCall => "#22c55e",  // green
            EdgeKind::MethodCall => "#14b8a6",    // teal
            EdgeKind::TypeReference => "#f59e0b", // amber
            EdgeKind::Inheritance => "#ef4444",   // red
            EdgeKind::TraitImpl => "#a855f7",     // purple
            EdgeKind::VariableUsage => "#64748b", // slate
        }
    }
}

/// An edge in the code graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeEdge {
    pub source: NodeId,
    pub target: NodeId,
    pub kind: EdgeKind,
    /// Weight/frequency of this relationship.
    pub weight: u32,
}

/// An aggregated edge representing multiple collapsed relationships.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregatedEdge {
    pub source: NodeId,
    pub target: NodeId,
    pub kind: EdgeKind,
    pub count: u32,
}
