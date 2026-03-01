use serde::{Deserialize, Serialize};

/// Stable identifier for a node in the code graph.
/// Uses the relative file path + optional block path for uniqueness.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NodeId(pub String);

impl NodeId {
    pub fn directory(rel_path: &str) -> Self {
        Self(rel_path.to_string())
    }

    pub fn file(rel_path: &str) -> Self {
        Self(rel_path.to_string())
    }

    pub fn code_block(file_path: &str, name: &str, start_line: usize) -> Self {
        Self(format!("{}::{}@{}", file_path, name, start_line))
    }
}

impl std::fmt::Display for NodeId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Span within a source file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Span {
    pub start_line: usize,
    pub start_col: usize,
    pub end_line: usize,
    pub end_col: usize,
}

/// The kind of code block extracted from source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BlockKind {
    Function,
    Class,
    Struct,
    Enum,
    Trait,
    Interface,
    Impl,
    Module,
    Constant,
    TypeAlias,
}

/// Visibility of a code symbol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Visibility {
    Public,
    Private,
    Protected,
    Crate,
}

/// A node in the code graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CodeNode {
    Directory {
        id: NodeId,
        name: String,
        /// Relative path from repo root
        path: String,
        children: Vec<NodeId>,
    },
    File {
        id: NodeId,
        name: String,
        path: String,
        language: Option<Language>,
        children: Vec<NodeId>,
    },
    CodeBlock {
        id: NodeId,
        name: String,
        kind: BlockKind,
        span: Span,
        signature: Option<String>,
        visibility: Option<Visibility>,
        parent: NodeId,
        children: Vec<NodeId>,
    },
}

impl CodeNode {
    pub fn id(&self) -> &NodeId {
        match self {
            CodeNode::Directory { id, .. } => id,
            CodeNode::File { id, .. } => id,
            CodeNode::CodeBlock { id, .. } => id,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            CodeNode::Directory { name, .. } => name,
            CodeNode::File { name, .. } => name,
            CodeNode::CodeBlock { name, .. } => name,
        }
    }

    pub fn children(&self) -> &[NodeId] {
        match self {
            CodeNode::Directory { children, .. } => children,
            CodeNode::File { children, .. } => children,
            CodeNode::CodeBlock { children, .. } => children,
        }
    }

    pub fn children_mut(&mut self) -> &mut Vec<NodeId> {
        match self {
            CodeNode::Directory { children, .. } => children,
            CodeNode::File { children, .. } => children,
            CodeNode::CodeBlock { children, .. } => children,
        }
    }

    pub fn is_directory(&self) -> bool {
        matches!(self, CodeNode::Directory { .. })
    }

    pub fn is_file(&self) -> bool {
        matches!(self, CodeNode::File { .. })
    }

    pub fn is_code_block(&self) -> bool {
        matches!(self, CodeNode::CodeBlock { .. })
    }
}

/// Supported programming languages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Language {
    Python,
    TypeScript,
    JavaScript,
    Rust,
}

impl Language {
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext {
            "py" => Some(Language::Python),
            "ts" | "tsx" => Some(Language::TypeScript),
            "js" | "jsx" => Some(Language::JavaScript),
            "rs" => Some(Language::Rust),
            _ => None,
        }
    }
}
