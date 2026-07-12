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

/// How confidently a reference was resolved to its target.
///
/// Variants are ordered worst -> best so that the derived `Ord` doubles as a
/// confidence comparison: `Ambiguous < GlobalUnique < Imported < SameFile`.
/// When two duplicate edges are merged (see `CodeGraph::add_edge`) the higher
/// (more confident) resolution is kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Resolution {
    /// The name matched several candidates and we could not disambiguate; the
    /// edge is one of up to 5 flagged guesses (rendered dashed/dimmed).
    Ambiguous,
    /// Exactly one symbol with this name exists in the whole repo.
    GlobalUnique,
    /// The target lives in a file the source file imports.
    Imported,
    /// The target is defined in the same file as the source.
    SameFile,
}

impl Default for Resolution {
    fn default() -> Self {
        // Neutral, non-ambiguous default for edges constructed without an
        // explicit resolution (e.g. in tests/benches).
        Resolution::GlobalUnique
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
    /// Confidence with which this edge's reference was resolved.
    #[serde(default)]
    pub resolution: Resolution,
}

impl CodeEdge {
    /// Construct an edge with an explicit resolution.
    pub fn new(
        source: NodeId,
        target: NodeId,
        kind: EdgeKind,
        weight: u32,
        resolution: Resolution,
    ) -> Self {
        Self {
            source,
            target,
            kind,
            weight,
            resolution,
        }
    }
}

/// An aggregated edge representing multiple collapsed relationships.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregatedEdge {
    pub source: NodeId,
    pub target: NodeId,
    pub kind: EdgeKind,
    pub count: u32,
}
