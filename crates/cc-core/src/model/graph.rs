use std::collections::{HashMap, HashSet};
use std::ops::{Deref, DerefMut};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use super::edge_index::EdgeIndex;
use super::{AggregatedEdge, CodeEdge, CodeNode, EdgeKind, NodeId};

/// The graph's node map plus its lazily-built child -> parent index.
///
/// The parent map is derived purely from the nodes' `children` arrays, and every
/// interactive query (`get_subgraph`, `neighborhood`, `edge_detail`) needs it, so
/// rebuilding it per call costs two `String` clones per child edge on every user
/// interaction. Caching it is only safe if no mutation can leave it stale, which
/// is what `DerefMut` guarantees here: `Deref` hands out the `HashMap` for reads,
/// `DerefMut` drops the cache before handing out `&mut`, so ANY mutating access
/// -- `insert`, `get_mut`, `retain`, `values_mut`, a `children_mut()` push
/// through a `get_mut` -- invalidates it. There is no way to mutate the nodes
/// without going through `DerefMut`, so the cache cannot go stale.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeMap {
    nodes: HashMap<NodeId, CodeNode>,
    #[serde(skip)]
    parent_map: OnceLock<HashMap<NodeId, NodeId>>,
}

impl NodeMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// The child -> parent map built from every node's `children` array, built
    /// on first use and reused until the nodes are mutated.
    ///
    /// After the parsing phase populates the `children` hierarchy, this is the
    /// authoritative parent map used for lifting edge endpoints to ancestors.
    pub fn parent_map(&self) -> &HashMap<NodeId, NodeId> {
        self.parent_map.get_or_init(|| {
            let mut parent_map = HashMap::new();
            for (node_id, node) in self.nodes.iter() {
                for child_id in node.children() {
                    parent_map.insert(child_id.clone(), node_id.clone());
                }
            }
            parent_map
        })
    }

    /// True when the parent map is currently cached (test/diagnostic hook).
    pub fn parent_map_is_cached(&self) -> bool {
        self.parent_map.get().is_some()
    }
}

impl Deref for NodeMap {
    type Target = HashMap<NodeId, CodeNode>;

    fn deref(&self) -> &Self::Target {
        &self.nodes
    }
}

impl DerefMut for NodeMap {
    fn deref_mut(&mut self) -> &mut Self::Target {
        // Any mutable access can change the containment hierarchy: drop the
        // derived index rather than try to guess whether it did.
        self.parent_map = OnceLock::new();
        &mut self.nodes
    }
}

impl<'a> IntoIterator for &'a NodeMap {
    type Item = (&'a NodeId, &'a CodeNode);
    type IntoIter = std::collections::hash_map::Iter<'a, NodeId, CodeNode>;

    fn into_iter(self) -> Self::IntoIter {
        self.nodes.iter()
    }
}

impl From<HashMap<NodeId, CodeNode>> for NodeMap {
    fn from(nodes: HashMap<NodeId, CodeNode>) -> Self {
        Self {
            nodes,
            parent_map: OnceLock::new(),
        }
    }
}

/// The full code graph for a repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeGraph {
    pub nodes: NodeMap,
    pub edges: Vec<CodeEdge>,
    pub root: NodeId,
    /// Forward adjacency: source -> [(target, edge_index)]
    #[serde(skip)]
    pub forward_adj: HashMap<NodeId, Vec<(NodeId, usize)>>,
    /// Reverse adjacency: target -> [(source, edge_index)]
    #[serde(skip)]
    pub reverse_adj: HashMap<NodeId, Vec<(NodeId, usize)>>,
    /// Dedup index: (source, target, kind) -> edge index
    #[serde(skip)]
    pub edge_index: EdgeIndex,
}

impl CodeGraph {
    pub fn new(root_id: NodeId) -> Self {
        Self {
            nodes: NodeMap::new(),
            edges: Vec::new(),
            root: root_id,
            forward_adj: HashMap::new(),
            reverse_adj: HashMap::new(),
            edge_index: EdgeIndex::new(),
        }
    }

    pub fn add_node(&mut self, node: CodeNode) {
        self.nodes.insert(node.id().clone(), node);
    }

    pub fn add_edge(&mut self, edge: CodeEdge) {
        if let Some(idx) = self.edge_index.get(&edge.source, &edge.target, &edge.kind) {
            self.edges[idx].weight = self.edges[idx].weight.saturating_add(edge.weight);
            // Keep the highest-confidence resolution among the merged duplicates.
            if edge.resolution > self.edges[idx].resolution {
                self.edges[idx].resolution = edge.resolution;
            }
            return;
        }
        let idx = self.edges.len();
        self.edge_index.insert(
            edge.source.clone(),
            edge.target.clone(),
            edge.kind.clone(),
            idx,
        );
        self.forward_adj
            .entry(edge.source.clone())
            .or_default()
            .push((edge.target.clone(), idx));
        self.reverse_adj
            .entry(edge.target.clone())
            .or_default()
            .push((edge.source.clone(), idx));
        self.edges.push(edge);
    }

    pub fn node(&self, id: &NodeId) -> Option<&CodeNode> {
        self.nodes.get(id)
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    /// Rebuild adjacency indexes from the edges vec.
    pub fn rebuild_adjacency(&mut self) {
        self.forward_adj.clear();
        self.reverse_adj.clear();
        for (idx, edge) in self.edges.iter().enumerate() {
            self.forward_adj
                .entry(edge.source.clone())
                .or_default()
                .push((edge.target.clone(), idx));
            self.reverse_adj
                .entry(edge.target.clone())
                .or_default()
                .push((edge.source.clone(), idx));
        }
        self.edge_index.rebuild(&self.edges);
    }

    /// The cached child -> parent map (see [`NodeMap::parent_map`]).
    pub fn parent_map(&self) -> &HashMap<NodeId, NodeId> {
        self.nodes.parent_map()
    }
}

/// Walk up the parent chain from `node_id` until a node in `render_set` is
/// found. Returns the node itself if it is already in the set, or `None` if no
/// ancestor is in the set.
fn find_render_ancestor<'a>(
    node_id: &'a NodeId,
    render_set: &'a HashSet<&NodeId>,
    parent_map: &'a HashMap<NodeId, NodeId>,
) -> Option<&'a NodeId> {
    let mut current = node_id;
    loop {
        if let Some(found) = render_set.get(current) {
            return Some(*found);
        }
        match parent_map.get(current) {
            Some(parent) => current = parent,
            None => return None,
        }
    }
}

/// Return true if `maybe_ancestor` is a (strict) ancestor of `node_id` in the
/// parent map.
fn is_ancestor_of(
    maybe_ancestor: &NodeId,
    node_id: &NodeId,
    parent_map: &HashMap<NodeId, NodeId>,
) -> bool {
    let mut current = parent_map.get(node_id);
    while let Some(c) = current {
        if c == maybe_ancestor {
            return true;
        }
        current = parent_map.get(c);
    }
    false
}

/// A filtered subgraph for frontend rendering.
///
/// The frontend already holds the node tree, so a `SubGraph` only carries the
/// per-view edges computed server-side: `edges` (both endpoints present in the
/// render set) and `aggregated_edges` (edges lifted to their nearest rendered
/// ancestor for collapsed containers).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubGraph {
    pub edges: Vec<CodeEdge>,
    pub aggregated_edges: Vec<AggregatedEdge>,
}

impl SubGraph {
    /// Compute the direct + aggregated edges for a given render view.
    ///
    /// `render_ids` are the node ids actually present in the layout tree (nodes
    /// that are visible AND whose ancestors are all expanded -- the frontend's
    /// `elkNodeIds`). `enabled_edge_kinds` filters by edge kind.
    ///
    /// - Direct edges: both endpoints in `render_ids`, kind enabled.
    /// - Aggregated edges: for edges with at least one endpoint NOT in
    ///   `render_ids`, lift each endpoint to its nearest ancestor in the set;
    ///   skip when unresolvable, when both lift to the same node (self-loop),
    ///   when one lifted endpoint is an ancestor of the other, or when the
    ///   lifted pair is already connected by a direct edge of the same kind.
    ///   Deduped by (source, target, kind) -- one aggregated edge per kind and
    ///   pair, so an edge's kind (and therefore its colour) is always exact;
    ///   `count` accumulates the underlying edges collapsed into each one.
    pub fn from_graph(
        graph: &CodeGraph,
        render_ids: &[NodeId],
        enabled_edge_kinds: &HashSet<EdgeKind>,
    ) -> Self {
        let render_set: HashSet<&NodeId> = render_ids.iter().collect();
        let parent_map = graph.parent_map();

        let mut edges: Vec<CodeEdge> = Vec::new();
        // Preserve insertion order of aggregated edges for stable output.
        let mut agg_order: Vec<(NodeId, NodeId, EdgeKind)> = Vec::new();
        let mut agg_map: HashMap<(NodeId, NodeId, EdgeKind), AggregatedEdge> = HashMap::new();

        // (pair, kind) triples already connected by a direct edge. Aggregation
        // must not duplicate them: e.g. a file->file Import edge plus a
        // file->block Import edge whose block endpoint is hidden would
        // otherwise render as two parallel Import edges between the same pair.
        // Keyed by kind so a direct edge of one kind does not suppress an
        // aggregate of a different kind between the same pair.
        let direct_pairs: HashSet<(&NodeId, &NodeId, &EdgeKind)> = graph
            .edges
            .iter()
            .filter(|e| {
                enabled_edge_kinds.contains(&e.kind)
                    && render_set.contains(&e.source)
                    && render_set.contains(&e.target)
            })
            .map(|e| (&e.source, &e.target, &e.kind))
            .collect();

        for edge in graph.edges.iter() {
            if !enabled_edge_kinds.contains(&edge.kind) {
                continue;
            }

            let source_in = render_set.contains(&edge.source);
            let target_in = render_set.contains(&edge.target);

            if source_in && target_in {
                // Direct edge: both endpoints rendered.
                edges.push(edge.clone());
                continue;
            }

            // At least one endpoint is hidden -- lift to nearest rendered ancestor.
            let lifted_source =
                match find_render_ancestor(&edge.source, &render_set, parent_map) {
                    Some(id) => id,
                    None => continue,
                };
            let lifted_target =
                match find_render_ancestor(&edge.target, &render_set, parent_map) {
                    Some(id) => id,
                    None => continue,
                };

            // Skip self-loops (both endpoints resolve to the same container).
            if lifted_source == lifted_target {
                continue;
            }

            // Skip when one lifted endpoint is an ancestor of the other -- an
            // edge from a node into its own containing box is misleading.
            if is_ancestor_of(lifted_source, lifted_target, parent_map)
                || is_ancestor_of(lifted_target, lifted_source, parent_map)
            {
                continue;
            }

            // Skip pairs already connected by a direct edge of this kind.
            if direct_pairs.contains(&(lifted_source, lifted_target, &edge.kind)) {
                continue;
            }

            let key = (lifted_source.clone(), lifted_target.clone(), edge.kind.clone());
            match agg_map.get_mut(&key) {
                Some(agg) => {
                    agg.count = agg.count.saturating_add(1);
                }
                None => {
                    agg_order.push(key.clone());
                    agg_map.insert(
                        key,
                        AggregatedEdge {
                            source: lifted_source.clone(),
                            target: lifted_target.clone(),
                            kind: edge.kind.clone(),
                            count: 1,
                        },
                    );
                }
            }
        }

        let aggregated_edges: Vec<AggregatedEdge> = agg_order
            .into_iter()
            .filter_map(|key| agg_map.remove(&key))
            .collect();

        SubGraph {
            edges,
            aggregated_edges,
        }
    }
}

/// Which way a focus trace walks the graph from its focus node.
///
/// The BFS follows this direction at EVERY hop, not just the first, so an
/// `Upstream` trace is a pure caller chain and a `Downstream` trace a pure
/// callee chain. `Both` is the default and reproduces the original
/// bidirectional neighborhood.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FocusDirection {
    /// Callers and callees (`reverse_adj` + `forward_adj`).
    #[default]
    Both,
    /// Callers only (`reverse_adj`): who reaches the focus.
    Upstream,
    /// Callees only (`forward_adj`): what the focus reaches.
    Downstream,
}

impl FocusDirection {
    /// Whether this direction walks `forward_adj` (focus -> target).
    fn follows_forward(self) -> bool {
        matches!(self, FocusDirection::Both | FocusDirection::Downstream)
    }

    /// Whether this direction walks `reverse_adj` (source -> focus).
    fn follows_reverse(self) -> bool {
        matches!(self, FocusDirection::Both | FocusDirection::Upstream)
    }
}

/// A local neighborhood extracted around a focus node for drill-down rendering.
///
/// `node_ids` is the closure of every node reachable within `depth` hops of the
/// focus (following edges in the requested `direction`), plus the container chain
/// (parents up to the root) of each such node so the frontend can build the ELK
/// containment tree. `edges` are the direct edges (with resolution) among the
/// neighborhood nodes only (excludes container-chain-only nodes that have no
/// edge among the set).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Neighborhood {
    pub focus: NodeId,
    pub depth: u8,
    /// The direction the trace was walked in; echoed back so the caller can tell
    /// which query a payload answers.
    pub direction: FocusDirection,
    pub node_ids: Vec<NodeId>,
    pub edges: Vec<CodeEdge>,
}

impl CodeGraph {
    /// Compute the neighborhood around `focus` by breadth-first search over
    /// `forward_adj` and/or `reverse_adj` (per `direction`), bounded by `depth`
    /// hops and filtered to `enabled_edge_kinds`. Returns `None` if `focus` is
    /// not a node in the graph.
    ///
    /// The returned `node_ids` include, in addition to the BFS frontier, the
    /// container chain (parents up to the root, via the `children` hierarchy) of
    /// every discovered node, so callers can render context containers. `edges`
    /// are the direct edges among the discovered (BFS) nodes, carrying their
    /// resolution; container-only nodes contribute no edges.
    ///
    /// `depth` is clamped to `1..=2`.
    pub fn neighborhood(
        &self,
        focus: &NodeId,
        depth: u8,
        enabled_edge_kinds: &HashSet<EdgeKind>,
        direction: FocusDirection,
    ) -> Option<Neighborhood> {
        if !self.nodes.contains_key(focus) {
            return None;
        }
        let depth = depth.clamp(1, 2);

        // BFS in the requested direction(s), tracking discovered nodes.
        // `frontier` carries the nodes to expand at the current level.
        let mut discovered: HashSet<NodeId> = HashSet::new();
        discovered.insert(focus.clone());
        let mut frontier: Vec<NodeId> = vec![focus.clone()];

        for _ in 0..depth {
            let mut next: Vec<NodeId> = Vec::new();
            for node in frontier.drain(..) {
                // Forward: node -> target (callees)
                if let Some(adj) = self
                    .forward_adj
                    .get(&node)
                    .filter(|_| direction.follows_forward())
                {
                    for (target, edge_idx) in adj {
                        if !enabled_edge_kinds.contains(&self.edges[*edge_idx].kind) {
                            continue;
                        }
                        if discovered.insert(target.clone()) {
                            next.push(target.clone());
                        }
                    }
                }
                // Reverse: source -> node (callers)
                if let Some(adj) = self
                    .reverse_adj
                    .get(&node)
                    .filter(|_| direction.follows_reverse())
                {
                    for (source, edge_idx) in adj {
                        if !enabled_edge_kinds.contains(&self.edges[*edge_idx].kind) {
                            continue;
                        }
                        if discovered.insert(source.clone()) {
                            next.push(source.clone());
                        }
                    }
                }
            }
            frontier = next;
        }

        // Direct edges among discovered nodes only (before adding container
        // chains, so container-only nodes never introduce spurious edges).
        let edges: Vec<CodeEdge> = self
            .edges
            .iter()
            .filter(|e| {
                enabled_edge_kinds.contains(&e.kind)
                    && discovered.contains(&e.source)
                    && discovered.contains(&e.target)
            })
            .cloned()
            .collect();

        // Include the container chain (parents up to root) of every discovered
        // node so the frontend can build the containment tree.
        let parent_map = self.parent_map();
        let mut node_set: HashSet<NodeId> = discovered.clone();
        for node in discovered.iter() {
            let mut current = node.clone();
            while let Some(parent) = parent_map.get(&current) {
                if !node_set.insert(parent.clone()) {
                    break;
                }
                current = parent.clone();
            }
        }

        let mut node_ids: Vec<NodeId> = node_set.into_iter().collect();
        node_ids.sort_by(|a, b| a.0.cmp(&b.0));

        Some(Neighborhood {
            focus: focus.clone(),
            depth,
            direction,
            node_ids,
            edges,
        })
    }
}

/// The underlying edges behind ONE aggregated view edge, for drill-in.
///
/// An aggregated `source -> target` edge in a view collapses every graph edge
/// running from the `source` subtree into the `target` subtree. `EdgeDetail`
/// re-expands exactly that set: `edges` are those underlying edges (direction
/// preserved -- `target -> source` traffic is a different aggregate and never
/// appears here), and `node_ids` are their endpoints plus the container chain
/// (parents up to the root) of each endpoint, matching `Neighborhood.node_ids`
/// so the frontend builds the ELK containment tree identically.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeDetail {
    pub source: NodeId,
    pub target: NodeId,
    pub node_ids: Vec<NodeId>,
    pub edges: Vec<CodeEdge>,
}

/// Return true if `node_id` is `container` itself or any of its descendants.
fn is_self_or_descendant(
    node_id: &NodeId,
    container: &NodeId,
    parent_map: &HashMap<NodeId, NodeId>,
) -> bool {
    node_id == container || is_ancestor_of(container, node_id, parent_map)
}

impl CodeGraph {
    /// Expand the aggregated `source -> target` edge into its contributing graph
    /// edges: every edge whose kind is in `enabled_edge_kinds`, whose source
    /// endpoint is `source` or a descendant of it, AND whose target endpoint is
    /// `target` or a descendant of it. Returns `None` if either id is unknown.
    ///
    /// Direction is significant: this is the exact set of edges that lifts into
    /// the `source -> target` aggregate, never the reverse one. When nothing
    /// matches, the returned detail is empty (not `None`) -- the endpoints exist,
    /// there is simply no traffic between them under these kinds.
    pub fn edge_detail(
        &self,
        source: &NodeId,
        target: &NodeId,
        enabled_edge_kinds: &HashSet<EdgeKind>,
    ) -> Option<EdgeDetail> {
        if !self.nodes.contains_key(source) || !self.nodes.contains_key(target) {
            return None;
        }
        let parent_map = self.parent_map();

        let edges: Vec<CodeEdge> = self
            .edges
            .iter()
            .filter(|e| {
                enabled_edge_kinds.contains(&e.kind)
                    && is_self_or_descendant(&e.source, source, parent_map)
                    && is_self_or_descendant(&e.target, target, parent_map)
            })
            .cloned()
            .collect();

        // Endpoints plus their container chains, so the frontend can build the
        // containment tree (same convention as `Neighborhood.node_ids`).
        let mut node_set: HashSet<NodeId> = HashSet::new();
        for e in edges.iter() {
            node_set.insert(e.source.clone());
            node_set.insert(e.target.clone());
        }
        for node in node_set.clone().iter() {
            let mut current = node.clone();
            while let Some(parent) = parent_map.get(&current) {
                if !node_set.insert(parent.clone()) {
                    break;
                }
                current = parent.clone();
            }
        }

        let mut node_ids: Vec<NodeId> = node_set.into_iter().collect();
        node_ids.sort_by(|a, b| a.0.cmp(&b.0));

        Some(EdgeDetail {
            source: source.clone(),
            target: target.clone(),
            node_ids,
            edges,
        })
    }
}

/// The edge-less parse response sent over IPC.
///
/// The full graph (nodes + edges) stays in server-side state; the frontend
/// receives the node tree once plus a compact connectivity map so it can run
/// the `hideUnconnectedNodes` filter synchronously without holding edges.
///
/// It BORROWS the live node map: serialization streams straight out of the
/// graph, so handing this to the frontend costs no copy of the node map at all.
/// Nodes go over the wire in their slim form (see [`SlimNode`]) -- the panel-only
/// `signature` is fetched per node via [`NodeDetails`].
#[derive(Debug, Serialize)]
pub struct ParseResult<'a> {
    #[serde(serialize_with = "serialize_slim_nodes")]
    pub nodes: &'a NodeMap,
    pub root: NodeId,
    pub edge_count: usize,
    /// For each node touched by at least one edge, the distinct edge kinds that
    /// touch it (as either source or target).
    pub node_edge_kinds: HashMap<NodeId, Vec<EdgeKind>>,
}

impl<'a> ParseResult<'a> {
    /// Build an edge-less parse result borrowing a fully-parsed graph.
    pub fn from_graph(graph: &'a CodeGraph) -> Self {
        ParseResult {
            nodes: &graph.nodes,
            root: graph.root.clone(),
            edge_count: graph.edges.len(),
            node_edge_kinds: build_node_edge_kinds(graph),
        }
    }
}

/// An owned handle to the graph a parse/scan produced, serialized as a
/// [`ParseResult`].
///
/// A Tauri command's return value must outlive the borrow of the state it was
/// built from, which is why the borrowing `ParseResult` cannot be returned
/// directly. Sharing the graph through an `Arc` gets both: the command hands the
/// same allocation to server-side state and to the response, and serialization
/// still streams out of the live node map with no copy.
#[derive(Debug, Clone)]
pub struct ParseResponse(pub std::sync::Arc<CodeGraph>);

impl Serialize for ParseResponse {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        ParseResult::from_graph(&self.0).serialize(serializer)
    }
}

/// A node as it goes over the wire in the bulk parse payload: everything the
/// canvas, sidebar and containment tree need, and nothing else.
///
/// Borrowed field-by-field from a [`CodeNode`], so building one is free. The
/// only omitted field is `signature` -- the whole first line of every function,
/// the single largest contributor to the payload, and read by exactly one
/// surface (the details panel / hover tooltip), which fetches it on demand via
/// [`NodeDetails`].
#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum SlimNode<'a> {
    Directory {
        id: &'a NodeId,
        name: &'a str,
        path: &'a str,
        children: &'a [NodeId],
    },
    File {
        id: &'a NodeId,
        name: &'a str,
        path: &'a str,
        language: Option<&'a super::Language>,
        children: &'a [NodeId],
    },
    CodeBlock {
        id: &'a NodeId,
        name: &'a str,
        kind: &'a super::BlockKind,
        span: &'a super::Span,
        visibility: Option<&'a super::Visibility>,
        parent: &'a NodeId,
        children: &'a [NodeId],
    },
}

impl<'a> From<&'a CodeNode> for SlimNode<'a> {
    fn from(node: &'a CodeNode) -> Self {
        match node {
            CodeNode::Directory {
                id,
                name,
                path,
                children,
            } => SlimNode::Directory {
                id,
                name,
                path,
                children,
            },
            CodeNode::File {
                id,
                name,
                path,
                language,
                children,
            } => SlimNode::File {
                id,
                name,
                path,
                language: language.as_ref(),
                children,
            },
            CodeNode::CodeBlock {
                id,
                name,
                kind,
                span,
                signature: _,
                visibility,
                parent,
                children,
            } => SlimNode::CodeBlock {
                id,
                name,
                kind,
                span,
                visibility: visibility.as_ref(),
                parent,
                children,
            },
        }
    }
}

fn serialize_slim_nodes<S: serde::Serializer>(
    nodes: &NodeMap,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeMap;
    let mut map = serializer.serialize_map(Some(nodes.len()))?;
    for (id, node) in nodes {
        map.serialize_entry(id, &SlimNode::from(node))?;
    }
    map.end()
}

/// The per-node facts the bulk payload leaves out, fetched on demand for the
/// one node a user is looking at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeDetails {
    pub id: NodeId,
    /// The block's declaration line; `None` for files, directories, and blocks
    /// whose language support extracts no signature.
    pub signature: Option<String>,
}

impl NodeDetails {
    /// The on-demand facts for `id`, or `None` when the node is unknown.
    pub fn from_graph(graph: &CodeGraph, id: &NodeId) -> Option<Self> {
        let node = graph.node(id)?;
        let signature = match node {
            CodeNode::CodeBlock { signature, .. } => signature.clone(),
            _ => None,
        };
        Some(NodeDetails {
            id: id.clone(),
            signature,
        })
    }
}

/// Build the per-node connectivity map: for every node id that is an endpoint of
/// at least one edge, record the distinct edge kinds touching it. Deterministic
/// kind ordering (by discriminant) so output is stable.
pub fn build_node_edge_kinds(graph: &CodeGraph) -> HashMap<NodeId, Vec<EdgeKind>> {
    let mut kinds_by_node: HashMap<NodeId, HashSet<EdgeKind>> = HashMap::new();

    for edge in graph.edges.iter() {
        kinds_by_node
            .entry(edge.source.clone())
            .or_default()
            .insert(edge.kind.clone());
        kinds_by_node
            .entry(edge.target.clone())
            .or_default()
            .insert(edge.kind.clone());
    }

    kinds_by_node
        .into_iter()
        .map(|(node_id, kind_set)| {
            let mut kinds: Vec<EdgeKind> = kind_set.into_iter().collect();
            kinds.sort_by_key(|k| k.discriminant());
            (node_id, kinds)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Resolution;

    #[test]
    fn add_edge_merges_duplicates_by_kind_and_endpoint_pair() {
        let mut graph = CodeGraph::new(NodeId("root".into()));

        graph.add_edge(CodeEdge {
            source: NodeId("a".into()),
            target: NodeId("b".into()),
            kind: EdgeKind::FunctionCall,
            weight: 1,
            resolution: Resolution::GlobalUnique,
        });
        graph.add_edge(CodeEdge {
            source: NodeId("a".into()),
            target: NodeId("b".into()),
            kind: EdgeKind::FunctionCall,
            weight: 1,
            resolution: Resolution::GlobalUnique,
        });
        graph.add_edge(CodeEdge {
            source: NodeId("a".into()),
            target: NodeId("b".into()),
            kind: EdgeKind::MethodCall,
            weight: 1,
            resolution: Resolution::GlobalUnique,
        });

        assert_eq!(graph.edges.len(), 2);
        assert_eq!(graph.forward_adj.get(&NodeId("a".into())).unwrap().len(), 2);
        assert_eq!(graph.reverse_adj.get(&NodeId("b".into())).unwrap().len(), 2);

        let function_call = graph
            .edges
            .iter()
            .find(|edge| edge.kind == EdgeKind::FunctionCall)
            .unwrap();
        assert_eq!(function_call.weight, 2);
    }

    #[test]
    fn test_add_1000_unique_edges() {
        let mut graph = CodeGraph::new(NodeId("root".into()));
        for i in 0..1000 {
            graph.add_edge(CodeEdge {
                source: NodeId(format!("src_{}", i)),
                target: NodeId(format!("tgt_{}", i)),
                kind: EdgeKind::FunctionCall,
                weight: 1,
                resolution: Resolution::GlobalUnique,
            });
        }
        assert_eq!(graph.edge_count(), 1000);
        assert_eq!(graph.edges.len(), 1000);
    }

    #[test]
    fn test_edge_index_consistency() {
        let mut graph = CodeGraph::new(NodeId("root".into()));

        // Add 10 unique edges
        for i in 0..10 {
            graph.add_edge(CodeEdge {
                source: NodeId(format!("a_{}", i)),
                target: NodeId(format!("b_{}", i)),
                kind: EdgeKind::Import,
                weight: 1,
                resolution: Resolution::GlobalUnique,
            });
        }

        // Add 5 duplicates of existing edges
        for i in 0..5 {
            graph.add_edge(CodeEdge {
                source: NodeId(format!("a_{}", i)),
                target: NodeId(format!("b_{}", i)),
                kind: EdgeKind::Import,
                weight: 1,
                resolution: Resolution::GlobalUnique,
            });
        }

        // Add 3 edges with same endpoints but different kind
        for i in 0..3 {
            graph.add_edge(CodeEdge {
                source: NodeId(format!("a_{}", i)),
                target: NodeId(format!("b_{}", i)),
                kind: EdgeKind::MethodCall,
                weight: 1,
                resolution: Resolution::GlobalUnique,
            });
        }

        // 10 unique Import edges + 3 unique MethodCall edges = 13
        assert_eq!(graph.edges.len(), 13);
        assert_eq!(graph.edge_index.len(), 13);

        // Verify the first 5 Import edges have weight 2 (original + duplicate)
        for i in 0..5 {
            let src = NodeId(format!("a_{}", i));
            let tgt = NodeId(format!("b_{}", i));
            let idx = graph.edge_index.get(&src, &tgt, &EdgeKind::Import).unwrap();
            assert_eq!(graph.edges[idx].weight, 2);
        }

        // Verify the last 5 Import edges have weight 1
        for i in 5..10 {
            let src = NodeId(format!("a_{}", i));
            let tgt = NodeId(format!("b_{}", i));
            let idx = graph.edge_index.get(&src, &tgt, &EdgeKind::Import).unwrap();
            assert_eq!(graph.edges[idx].weight, 1);
        }
    }

    #[test]
    fn test_add_edge_weight_accumulation() {
        let mut graph = CodeGraph::new(NodeId("root".into()));

        for _ in 0..5 {
            graph.add_edge(CodeEdge {
                source: NodeId("x".into()),
                target: NodeId("y".into()),
                kind: EdgeKind::FunctionCall,
                weight: 1,
                resolution: Resolution::GlobalUnique,
            });
        }

        assert_eq!(graph.edges.len(), 1);
        assert_eq!(graph.edges[0].weight, 5);
        assert_eq!(graph.edge_index.len(), 1);
    }

    #[test]
    fn test_edge_index_rebuild_matches_inserts() {
        // Build a graph by adding edges one-by-one
        let mut graph_incremental = CodeGraph::new(NodeId("root".into()));
        let edges: Vec<CodeEdge> = (0..50)
            .map(|i| CodeEdge {
                source: NodeId(format!("src_{}", i)),
                target: NodeId(format!("tgt_{}", i)),
                kind: if i % 3 == 0 {
                    EdgeKind::Import
                } else if i % 3 == 1 {
                    EdgeKind::FunctionCall
                } else {
                    EdgeKind::MethodCall
                },
                weight: 1,
                resolution: Resolution::GlobalUnique,
            })
            .collect();

        for edge in &edges {
            graph_incremental.add_edge(edge.clone());
        }

        // Build another graph by pushing edges directly, then calling rebuild_adjacency
        let mut graph_bulk = CodeGraph::new(NodeId("root".into()));
        for edge in &edges {
            graph_bulk.edges.push(edge.clone());
        }
        graph_bulk.rebuild_adjacency();

        // Assert both graphs have the same edge count
        assert_eq!(graph_incremental.edge_count(), graph_bulk.edge_count());

        // Assert both graphs have the same edges (same source/target/kind triples)
        for edge in &graph_incremental.edges {
            let found = graph_bulk.edges.iter().any(|e| {
                e.source == edge.source && e.target == edge.target && e.kind == edge.kind
            });
            assert!(
                found,
                "Edge ({}, {}, {:?}) present in incremental but missing in bulk",
                edge.source, edge.target, edge.kind
            );
        }
    }

    #[test]
    fn test_add_edge_updates_index_on_merge() {
        let mut graph = CodeGraph::new(NodeId("root".into()));

        graph.add_edge(CodeEdge {
            source: NodeId("a".into()),
            target: NodeId("b".into()),
            kind: EdgeKind::Import,
            weight: 3,
            resolution: Resolution::GlobalUnique,
        });
        // Add the same edge again
        graph.add_edge(CodeEdge {
            source: NodeId("a".into()),
            target: NodeId("b".into()),
            kind: EdgeKind::Import,
            weight: 7,
            resolution: Resolution::GlobalUnique,
        });

        // Edge count should still be 1
        assert_eq!(graph.edge_count(), 1);
        // Weight should be summed
        assert_eq!(graph.edges[0].weight, 10);
    }

    #[test]
    fn add_edge_merge_keeps_highest_confidence_resolution() {
        let mut graph = CodeGraph::new(NodeId("root".into()));

        // First add a low-confidence (Ambiguous) edge...
        graph.add_edge(CodeEdge {
            source: NodeId("a".into()),
            target: NodeId("b".into()),
            kind: EdgeKind::FunctionCall,
            weight: 1,
            resolution: Resolution::Ambiguous,
        });
        // ...then a higher-confidence (SameFile) duplicate.
        graph.add_edge(CodeEdge {
            source: NodeId("a".into()),
            target: NodeId("b".into()),
            kind: EdgeKind::FunctionCall,
            weight: 1,
            resolution: Resolution::SameFile,
        });
        // ...and a middling one that must NOT downgrade the kept resolution.
        graph.add_edge(CodeEdge {
            source: NodeId("a".into()),
            target: NodeId("b".into()),
            kind: EdgeKind::FunctionCall,
            weight: 1,
            resolution: Resolution::Imported,
        });

        assert_eq!(graph.edge_count(), 1);
        assert_eq!(graph.edges[0].weight, 3, "weights still accumulate");
        assert_eq!(
            graph.edges[0].resolution,
            Resolution::SameFile,
            "merge should keep the highest-confidence resolution"
        );
    }

    #[test]
    fn test_large_graph_no_duplicate_edges() {
        use std::collections::HashSet;

        let mut graph = CodeGraph::new(NodeId("root".into()));
        let mut unique_keys: HashSet<(String, String, String)> = HashSet::new();

        for i in 0..1000 {
            // 20% of edges are duplicates: indices 0,5,10,... map to a small set
            let (src, tgt, kind) = if i % 5 == 0 {
                let hot = i % 50;
                (
                    format!("hot_src_{}", hot),
                    format!("hot_tgt_{}", hot),
                    EdgeKind::FunctionCall,
                )
            } else {
                (
                    format!("src_{}", i),
                    format!("tgt_{}", i),
                    EdgeKind::Import,
                )
            };

            unique_keys.insert((src.clone(), tgt.clone(), format!("{:?}", kind)));

            graph.add_edge(CodeEdge {
                source: NodeId(src),
                target: NodeId(tgt),
                kind,
                weight: 1,
                resolution: Resolution::GlobalUnique,
            });
        }

        // The final edge count must equal the number of unique (source, target, kind) combos
        assert_eq!(graph.edge_count(), unique_keys.len());
    }

    // --- SubGraph aggregation parity + ParseResult connectivity tests ---

    use crate::model::{BlockKind, Span, Visibility};

    fn dir(id: &str, children: Vec<&str>) -> CodeNode {
        CodeNode::Directory {
            id: NodeId(id.into()),
            name: id.into(),
            path: id.into(),
            children: children.into_iter().map(|c| NodeId(c.into())).collect(),
        }
    }

    fn file(id: &str, parent_children: Vec<&str>) -> CodeNode {
        CodeNode::File {
            id: NodeId(id.into()),
            name: id.into(),
            path: id.into(),
            language: Some(crate::model::Language::Python),
            children: parent_children
                .into_iter()
                .map(|c| NodeId(c.into()))
                .collect(),
        }
    }

    fn block(id: &str, parent: &str) -> CodeNode {
        CodeNode::CodeBlock {
            id: NodeId(id.into()),
            name: id.into(),
            kind: BlockKind::Function,
            span: Span {
                start_line: 1,
                start_col: 0,
                end_line: 1,
                end_col: 0,
            },
            signature: None,
            visibility: Some(Visibility::Public),
            parent: NodeId(parent.into()),
            children: Vec::new(),
        }
    }

    /// Build a graph:
    /// root -> [fileA, fileB]
    /// fileA -> [fnA1, fnA2]
    /// fileB -> [fnB1]
    fn sample_graph() -> CodeGraph {
        let mut g = CodeGraph::new(NodeId("root".into()));
        g.add_node(dir("root", vec!["fileA", "fileB"]));
        g.add_node(file("fileA", vec!["fnA1", "fnA2"]));
        g.add_node(file("fileB", vec!["fnB1"]));
        g.add_node(block("fnA1", "fileA"));
        g.add_node(block("fnA2", "fileA"));
        g.add_node(block("fnB1", "fileB"));
        g
    }

    fn all_kinds() -> HashSet<EdgeKind> {
        [
            EdgeKind::Import,
            EdgeKind::FunctionCall,
            EdgeKind::MethodCall,
            EdgeKind::TypeReference,
            EdgeKind::Inheritance,
            EdgeKind::TraitImpl,
            EdgeKind::VariableUsage,
        ]
        .into_iter()
        .collect()
    }

    fn edge(src: &str, tgt: &str, kind: EdgeKind) -> CodeEdge {
        CodeEdge {
            source: NodeId(src.into()),
            target: NodeId(tgt.into()),
            kind,
            weight: 1,
            resolution: Resolution::GlobalUnique,
        }
    }

    #[test]
    fn subgraph_direct_edge_when_both_endpoints_rendered() {
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));

        let render: Vec<NodeId> = ["fnA1", "fnB1"].iter().map(|s| NodeId(s.to_string())).collect();
        let sub = SubGraph::from_graph(&g, &render, &all_kinds());

        assert_eq!(sub.edges.len(), 1);
        assert_eq!(sub.aggregated_edges.len(), 0);
        assert_eq!(sub.edges[0].source, NodeId("fnA1".into()));
        assert_eq!(sub.edges[0].target, NodeId("fnB1".into()));
    }

    #[test]
    fn subgraph_aggregation_skips_pairs_with_direct_edge() {
        // fileA imports fileB directly (file->file) AND has an Import edge to a
        // block inside fileB (file->block). With fileB collapsed, the lifted
        // file->block edge must NOT duplicate the direct file->file edge.
        let mut g = sample_graph();
        g.add_edge(edge("fileA", "fileB", EdgeKind::Import));
        g.add_edge(edge("fileA", "fnB1", EdgeKind::Import));

        let render: Vec<NodeId> = ["fileA", "fileB"]
            .iter()
            .map(|s| NodeId(s.to_string()))
            .collect();
        let sub = SubGraph::from_graph(&g, &render, &all_kinds());

        assert_eq!(sub.edges.len(), 1, "one direct file->file edge");
        assert_eq!(
            sub.aggregated_edges.len(),
            0,
            "lifted file->block edge must not duplicate the direct pair"
        );
    }

    #[test]
    fn subgraph_lifts_hidden_endpoint_to_rendered_ancestor() {
        let mut g = sample_graph();
        // Edge between two blocks; only the files are rendered.
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));

        let render: Vec<NodeId> = ["fileA", "fileB"].iter().map(|s| NodeId(s.to_string())).collect();
        let sub = SubGraph::from_graph(&g, &render, &all_kinds());

        assert_eq!(sub.edges.len(), 0);
        assert_eq!(sub.aggregated_edges.len(), 1);
        let agg = &sub.aggregated_edges[0];
        assert_eq!(agg.source, NodeId("fileA".into()));
        assert_eq!(agg.target, NodeId("fileB".into()));
        assert_eq!(agg.count, 1);
    }

    #[test]
    fn subgraph_skips_self_loop_after_lifting() {
        let mut g = sample_graph();
        // Two blocks in the same file; only fileA is rendered -> both lift to fileA.
        g.add_edge(edge("fnA1", "fnA2", EdgeKind::FunctionCall));

        let render: Vec<NodeId> = ["fileA", "fileB"].iter().map(|s| NodeId(s.to_string())).collect();
        let sub = SubGraph::from_graph(&g, &render, &all_kinds());

        assert_eq!(sub.edges.len(), 0);
        assert_eq!(sub.aggregated_edges.len(), 0);
    }

    #[test]
    fn subgraph_skips_ancestor_containment() {
        // Edge fnA1 -> fnA2 (both children of fileA). Render fileA (ancestor)
        // and fnA2 (descendant of fileA). fnA1 lifts to fileA; fnA2 is rendered.
        // fileA is an ancestor of fnA2 -> containment -> skip.
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnA2", EdgeKind::FunctionCall));
        let render: Vec<NodeId> = ["fileA", "fnA2"].iter().map(|s| NodeId(s.to_string())).collect();
        let sub = SubGraph::from_graph(&g, &render, &all_kinds());

        assert_eq!(sub.edges.len(), 0);
        assert_eq!(sub.aggregated_edges.len(), 0);
    }

    #[test]
    fn subgraph_filters_disabled_kinds() {
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::Import));

        let render: Vec<NodeId> = ["fnA1", "fnB1"].iter().map(|s| NodeId(s.to_string())).collect();
        let only_import: HashSet<EdgeKind> = [EdgeKind::Import].into_iter().collect();
        let sub = SubGraph::from_graph(&g, &render, &only_import);

        assert_eq!(sub.edges.len(), 1);
        assert_eq!(sub.edges[0].kind, EdgeKind::Import);
    }

    #[test]
    fn subgraph_dedups_aggregated_edges_of_same_kind_and_counts() {
        let mut g = sample_graph();
        // Two distinct block-level edges of the SAME kind both lifting to
        // fileA -> fileB collapse into one aggregate with count 2.
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));
        g.add_edge(edge("fnA2", "fnB1", EdgeKind::FunctionCall));

        let render: Vec<NodeId> = ["fileA", "fileB"].iter().map(|s| NodeId(s.to_string())).collect();
        let sub = SubGraph::from_graph(&g, &render, &all_kinds());

        assert_eq!(sub.aggregated_edges.len(), 1);
        let agg = &sub.aggregated_edges[0];
        assert_eq!(agg.source, NodeId("fileA".into()));
        assert_eq!(agg.target, NodeId("fileB".into()));
        assert_eq!(agg.count, 2);
        assert_eq!(agg.kind, EdgeKind::FunctionCall);
    }

    #[test]
    fn subgraph_splits_aggregated_edges_by_kind() {
        let mut g = sample_graph();
        // Block-level edges of DIFFERENT kinds lifting to the same pair must
        // stay separate aggregates -- an edge's kind (and colour) is exact,
        // never a "first kind seen" mixture.
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));
        g.add_edge(edge("fnA2", "fnB1", EdgeKind::FunctionCall));
        g.add_edge(edge("fnA2", "fnB1", EdgeKind::TypeReference));

        let render: Vec<NodeId> = ["fileA", "fileB"].iter().map(|s| NodeId(s.to_string())).collect();
        let sub = SubGraph::from_graph(&g, &render, &all_kinds());

        assert_eq!(sub.edges.len(), 0);
        assert_eq!(sub.aggregated_edges.len(), 2, "one aggregate per kind");

        let calls = sub
            .aggregated_edges
            .iter()
            .find(|a| a.kind == EdgeKind::FunctionCall)
            .expect("FunctionCall aggregate");
        assert_eq!(calls.count, 2);

        let type_refs = sub
            .aggregated_edges
            .iter()
            .find(|a| a.kind == EdgeKind::TypeReference)
            .expect("TypeReference aggregate");
        assert_eq!(type_refs.count, 1);

        for agg in &sub.aggregated_edges {
            assert_eq!(agg.source, NodeId("fileA".into()));
            assert_eq!(agg.target, NodeId("fileB".into()));
        }
    }

    #[test]
    fn subgraph_direct_edge_suppresses_only_same_kind_aggregates() {
        let mut g = sample_graph();
        // Direct file->file Import edge, plus a hidden block-level FunctionCall
        // lifting to the same pair: the Import direct edge must suppress only
        // Import aggregates, not the FunctionCall one.
        g.add_edge(edge("fileA", "fileB", EdgeKind::Import));
        g.add_edge(edge("fileA", "fnB1", EdgeKind::Import));
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));

        let render: Vec<NodeId> = ["fileA", "fileB"].iter().map(|s| NodeId(s.to_string())).collect();
        let sub = SubGraph::from_graph(&g, &render, &all_kinds());

        assert_eq!(sub.edges.len(), 1, "one direct Import edge");
        assert_eq!(sub.edges[0].kind, EdgeKind::Import);
        assert_eq!(
            sub.aggregated_edges.len(),
            1,
            "lifted Import suppressed by the direct pair; FunctionCall survives"
        );
        assert_eq!(sub.aggregated_edges[0].kind, EdgeKind::FunctionCall);
        assert_eq!(sub.aggregated_edges[0].count, 1);
    }

    #[test]
    fn subgraph_skips_unresolvable_endpoint() {
        let mut g = sample_graph();
        // Edge to a node id that isn't in the graph -> parent chain resolves to
        // None -> skip.
        g.edges.push(edge("fnA1", "ghost", EdgeKind::FunctionCall));
        g.rebuild_adjacency();

        let render: Vec<NodeId> = ["fileA", "fileB"].iter().map(|s| NodeId(s.to_string())).collect();
        let sub = SubGraph::from_graph(&g, &render, &all_kinds());

        assert_eq!(sub.edges.len(), 0);
        assert_eq!(sub.aggregated_edges.len(), 0);
    }

    #[test]
    fn build_node_edge_kinds_records_distinct_kinds_per_endpoint() {
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::Import));
        g.add_edge(edge("fnA2", "fnB1", EdgeKind::MethodCall));

        let map = build_node_edge_kinds(&g);

        // fnA1 touched by FunctionCall + Import.
        let fn_a1 = map.get(&NodeId("fnA1".into())).unwrap();
        assert_eq!(fn_a1, &vec![EdgeKind::Import, EdgeKind::FunctionCall]);
        // fnB1 touched by all three (sorted by discriminant).
        let fn_b1 = map.get(&NodeId("fnB1".into())).unwrap();
        assert_eq!(
            fn_b1,
            &vec![EdgeKind::Import, EdgeKind::FunctionCall, EdgeKind::MethodCall]
        );
        // A node with no edges is absent from the map.
        assert!(map.get(&NodeId("fileA".into())).is_none());
    }

    #[test]
    fn parse_result_from_graph_is_edge_less_with_connectivity() {
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));

        let result = ParseResult::from_graph(&g);
        assert_eq!(result.edge_count, 1);
        assert_eq!(result.root, NodeId("root".into()));
        assert_eq!(result.nodes.len(), g.nodes.len());
        assert!(result.node_edge_kinds.contains_key(&NodeId("fnA1".into())));
        assert!(result.node_edge_kinds.contains_key(&NodeId("fnB1".into())));
    }

    // --- Neighborhood (focus / drill-down) tests ---

    fn only_import() -> HashSet<EdgeKind> {
        [EdgeKind::Import].into_iter().collect()
    }

    #[test]
    fn neighborhood_unknown_node_returns_none() {
        let g = sample_graph();
        assert!(g
            .neighborhood(&NodeId("does_not_exist".into()), 1, &all_kinds(), FocusDirection::Both)
            .is_none());
    }

    #[test]
    fn neighborhood_includes_callers_and_callees_at_depth_1() {
        // fnA1 -> fnB1 (callee) and fnA2 -> fnA1 (caller of fnA1).
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));
        g.add_edge(edge("fnA2", "fnA1", EdgeKind::FunctionCall));

        let n = g
            .neighborhood(&NodeId("fnA1".into()), 1, &all_kinds(), FocusDirection::Both)
            .expect("known node");
        let ids: HashSet<&str> = n.node_ids.iter().map(|id| id.0.as_str()).collect();

        // BOTH the callee (fnB1) and the caller (fnA2) are within one hop.
        assert!(ids.contains("fnA1"), "focus itself");
        assert!(ids.contains("fnB1"), "callee reached via forward_adj");
        assert!(ids.contains("fnA2"), "caller reached via reverse_adj");
        // Edges among the neighborhood carry resolution.
        assert_eq!(n.edges.len(), 2);
        assert!(n.edges.iter().all(|e| e.resolution == Resolution::GlobalUnique));
    }

    #[test]
    fn neighborhood_respects_depth_bounds() {
        // Chain: fnA1 -> fnA2 -> fnB1. From fnA1 at depth 1, fnB1 is NOT reached;
        // at depth 2 it is.
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnA2", EdgeKind::FunctionCall));
        g.add_edge(edge("fnA2", "fnB1", EdgeKind::FunctionCall));

        let d1 = g
            .neighborhood(&NodeId("fnA1".into()), 1, &all_kinds(), FocusDirection::Both)
            .unwrap();
        let ids1: HashSet<&str> = d1.node_ids.iter().map(|id| id.0.as_str()).collect();
        assert!(ids1.contains("fnA2"), "one hop reaches fnA2");
        assert!(!ids1.contains("fnB1"), "two hops away, excluded at depth 1");

        let d2 = g
            .neighborhood(&NodeId("fnA1".into()), 2, &all_kinds(), FocusDirection::Both)
            .unwrap();
        let ids2: HashSet<&str> = d2.node_ids.iter().map(|id| id.0.as_str()).collect();
        assert!(ids2.contains("fnB1"), "two hops away, included at depth 2");
    }

    #[test]
    fn neighborhood_depth_is_clamped_to_1_2() {
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnA2", EdgeKind::FunctionCall));
        // depth 0 clamps up to 1; depth 5 clamps down to 2.
        assert_eq!(
            g.neighborhood(&NodeId("fnA1".into()), 0, &all_kinds(), FocusDirection::Both)
                .unwrap()
                .depth,
            1
        );
        assert_eq!(
            g.neighborhood(&NodeId("fnA1".into()), 5, &all_kinds(), FocusDirection::Both)
                .unwrap()
                .depth,
            2
        );
    }

    #[test]
    fn neighborhood_filters_by_edge_kind() {
        // fnA1 -Import-> fnB1 and fnA1 -FunctionCall-> fnA2.
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::Import));
        g.add_edge(edge("fnA1", "fnA2", EdgeKind::FunctionCall));

        let n = g
            .neighborhood(&NodeId("fnA1".into()), 1, &only_import(), FocusDirection::Both)
            .unwrap();
        let ids: HashSet<&str> = n.node_ids.iter().map(|id| id.0.as_str()).collect();
        assert!(ids.contains("fnB1"), "import neighbor kept");
        assert!(
            !ids.contains("fnA2"),
            "function-call neighbor filtered out by kind"
        );
        // Only the import edge survives.
        assert_eq!(n.edges.len(), 1);
        assert_eq!(n.edges[0].kind, EdgeKind::Import);
    }

    #[test]
    fn neighborhood_includes_container_chain() {
        // fnA1 -> fnB1: neighborhood nodes are {fnA1, fnB1}; container chain adds
        // their files (fileA, fileB) and the root.
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));

        let n = g
            .neighborhood(&NodeId("fnA1".into()), 1, &all_kinds(), FocusDirection::Both)
            .unwrap();
        let ids: HashSet<&str> = n.node_ids.iter().map(|id| id.0.as_str()).collect();
        assert!(ids.contains("fileA"), "container of fnA1");
        assert!(ids.contains("fileB"), "container of fnB1");
        assert!(ids.contains("root"), "root of the container chain");
        // Container-only nodes contribute no edges: still exactly the 1 direct edge.
        assert_eq!(n.edges.len(), 1);
        assert_eq!(n.edges[0].source, NodeId("fnA1".into()));
        assert_eq!(n.edges[0].target, NodeId("fnB1".into()));
    }

    // --- Directional trace (FocusDirection) tests ---

    /// fnA2 -> fnA1 -> fnB1: fnA2 is a caller (upstream) of fnA1, fnB1 a callee
    /// (downstream) of it.
    fn directional_graph() -> CodeGraph {
        let mut g = sample_graph();
        g.add_edge(edge("fnA2", "fnA1", EdgeKind::FunctionCall));
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));
        g
    }

    #[test]
    fn neighborhood_upstream_keeps_callers_and_excludes_callees() {
        let g = directional_graph();

        let n = g
            .neighborhood(
                &NodeId("fnA1".into()),
                1,
                &all_kinds(),
                FocusDirection::Upstream,
            )
            .unwrap();
        let ids: HashSet<&str> = n.node_ids.iter().map(|id| id.0.as_str()).collect();

        assert!(ids.contains("fnA2"), "caller reached via reverse_adj");
        assert!(!ids.contains("fnB1"), "callee excluded when tracing upstream");
        // Only the caller edge survives (the callee edge has an undiscovered end).
        assert_eq!(n.edges.len(), 1);
        assert_eq!(n.edges[0].source, NodeId("fnA2".into()));
        assert_eq!(n.edges[0].target, NodeId("fnA1".into()));
        assert_eq!(n.direction, FocusDirection::Upstream);
    }

    #[test]
    fn neighborhood_downstream_keeps_callees_and_excludes_callers() {
        let g = directional_graph();

        let n = g
            .neighborhood(
                &NodeId("fnA1".into()),
                1,
                &all_kinds(),
                FocusDirection::Downstream,
            )
            .unwrap();
        let ids: HashSet<&str> = n.node_ids.iter().map(|id| id.0.as_str()).collect();

        assert!(ids.contains("fnB1"), "callee reached via forward_adj");
        assert!(
            !ids.contains("fnA2"),
            "caller excluded when tracing downstream"
        );
        assert_eq!(n.edges.len(), 1);
        assert_eq!(n.edges[0].source, NodeId("fnA1".into()));
        assert_eq!(n.edges[0].target, NodeId("fnB1".into()));
        assert_eq!(n.direction, FocusDirection::Downstream);
    }

    #[test]
    fn neighborhood_both_is_the_union_of_the_two_directions() {
        let g = directional_graph();

        let both = g
            .neighborhood(&NodeId("fnA1".into()), 1, &all_kinds(), FocusDirection::Both)
            .unwrap();
        let ids: HashSet<&str> = both.node_ids.iter().map(|id| id.0.as_str()).collect();

        assert!(ids.contains("fnA2"), "caller kept");
        assert!(ids.contains("fnB1"), "callee kept");
        assert_eq!(both.edges.len(), 2);
        assert_eq!(both.direction, FocusDirection::Both);
        assert_eq!(
            FocusDirection::default(),
            FocusDirection::Both,
            "Both is the default, preserving the pre-direction behavior"
        );
    }

    #[test]
    fn neighborhood_direction_applies_per_hop_not_just_at_the_focus() {
        // fnB1 -> fnA1 -> fnA2 (a caller chain into fnA2). Tracing upstream from
        // fnA2 must walk fnA1 then fnB1, never turning around.
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnA2", EdgeKind::FunctionCall));
        g.add_edge(edge("fnB1", "fnA1", EdgeKind::FunctionCall));
        // A callee of fnA1 that must NOT be pulled in while tracing upstream.
        g.add_node(block("fnA3", "fileA"));
        g.add_edge(edge("fnA1", "fnA3", EdgeKind::FunctionCall));

        let n = g
            .neighborhood(
                &NodeId("fnA2".into()),
                2,
                &all_kinds(),
                FocusDirection::Upstream,
            )
            .unwrap();
        let ids: HashSet<&str> = n.node_ids.iter().map(|id| id.0.as_str()).collect();

        assert!(ids.contains("fnA1"), "direct caller");
        assert!(ids.contains("fnB1"), "caller of the caller (2 hops upstream)");
        assert!(
            !ids.contains("fnA3"),
            "a callee of an upstream node is not upstream of the focus"
        );
    }

    #[test]
    fn neighborhood_direction_still_includes_the_container_chain() {
        let g = directional_graph();

        let n = g
            .neighborhood(
                &NodeId("fnA1".into()),
                1,
                &all_kinds(),
                FocusDirection::Downstream,
            )
            .unwrap();
        let ids: HashSet<&str> = n.node_ids.iter().map(|id| id.0.as_str()).collect();

        assert!(ids.contains("fileA"), "container of the focus");
        assert!(ids.contains("fileB"), "container of the discovered callee");
        assert!(ids.contains("root"), "root of the container chain");
        // Container-only nodes still contribute no edges.
        assert_eq!(n.edges.len(), 1);
    }

    #[test]
    fn neighborhood_direction_respects_edge_kind_filtering() {
        // fnA1 -Import-> fnB1 downstream, fnA2 -FunctionCall-> fnA1 upstream.
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::Import));
        g.add_edge(edge("fnA2", "fnA1", EdgeKind::FunctionCall));

        let n = g
            .neighborhood(
                &NodeId("fnA1".into()),
                1,
                &only_import(),
                FocusDirection::Downstream,
            )
            .unwrap();
        let ids: HashSet<&str> = n.node_ids.iter().map(|id| id.0.as_str()).collect();

        assert!(ids.contains("fnB1"), "import callee kept");
        assert!(!ids.contains("fnA2"), "wrong kind AND wrong direction");
        assert_eq!(n.edges.len(), 1);
        assert_eq!(n.edges[0].kind, EdgeKind::Import);
    }

    #[test]
    fn focus_direction_serializes_as_lowercase_for_ipc() {
        // The frontend's FocusDirection union is lowercase; pin the wire format.
        assert_eq!(
            serde_json::to_string(&FocusDirection::Both).unwrap(),
            "\"both\""
        );
        assert_eq!(
            serde_json::to_string(&FocusDirection::Upstream).unwrap(),
            "\"upstream\""
        );
        assert_eq!(
            serde_json::to_string(&FocusDirection::Downstream).unwrap(),
            "\"downstream\""
        );
        assert_eq!(
            serde_json::from_str::<FocusDirection>("\"upstream\"").unwrap(),
            FocusDirection::Upstream
        );
    }

    // --- EdgeDetail (aggregated-edge drill-in) tests ---

    fn detail(g: &CodeGraph, source: &str, target: &str) -> EdgeDetail {
        g.edge_detail(
            &NodeId(source.into()),
            &NodeId(target.into()),
            &all_kinds(),
        )
        .expect("known endpoints")
    }

    fn edge_pairs(d: &EdgeDetail) -> HashSet<(&str, &str)> {
        d.edges
            .iter()
            .map(|e| (e.source.0.as_str(), e.target.0.as_str()))
            .collect()
    }

    #[test]
    fn edge_detail_unknown_ids_return_none() {
        let g = sample_graph();
        assert!(g
            .edge_detail(
                &NodeId("nope".into()),
                &NodeId("fileB".into()),
                &all_kinds()
            )
            .is_none());
        assert!(g
            .edge_detail(
                &NodeId("fileA".into()),
                &NodeId("nope".into()),
                &all_kinds()
            )
            .is_none());
    }

    #[test]
    fn edge_detail_collects_every_contributing_descendant_pair() {
        // Two block-level calls both lift into the same fileA -> fileB aggregate.
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));
        g.add_edge(edge("fnA2", "fnB1", EdgeKind::FunctionCall));

        let d = detail(&g, "fileA", "fileB");
        assert_eq!(d.source, NodeId("fileA".into()));
        assert_eq!(d.target, NodeId("fileB".into()));
        assert_eq!(
            edge_pairs(&d),
            [("fnA1", "fnB1"), ("fnA2", "fnB1")].into_iter().collect()
        );
    }

    #[test]
    fn edge_detail_includes_the_endpoints_own_edge() {
        // An edge whose endpoints ARE the queried pair (not descendants of it)
        // contributes too -- "self or descendant" on both sides.
        let mut g = sample_graph();
        g.add_edge(edge("fileA", "fileB", EdgeKind::Import));
        g.add_edge(edge("fnA1", "fileB", EdgeKind::Import));

        let d = detail(&g, "fileA", "fileB");
        assert_eq!(
            edge_pairs(&d),
            [("fileA", "fileB"), ("fnA1", "fileB")].into_iter().collect()
        );
    }

    #[test]
    fn edge_detail_excludes_the_reverse_direction() {
        // fileB -> fileA traffic must never appear in the fileA -> fileB drill-in.
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));
        g.add_edge(edge("fnB1", "fnA2", EdgeKind::FunctionCall));

        let d = detail(&g, "fileA", "fileB");
        assert_eq!(edge_pairs(&d), [("fnA1", "fnB1")].into_iter().collect());
        assert!(
            !d.node_ids.contains(&NodeId("fnA2".into())),
            "the reverse edge's endpoint is not part of this drill-in"
        );
    }

    #[test]
    fn edge_detail_filters_by_edge_kind() {
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::Import));
        g.add_edge(edge("fnA2", "fnB1", EdgeKind::FunctionCall));

        let d = g
            .edge_detail(
                &NodeId("fileA".into()),
                &NodeId("fileB".into()),
                &only_import(),
            )
            .unwrap();
        assert_eq!(edge_pairs(&d), [("fnA1", "fnB1")].into_iter().collect());
        assert!(d.edges.iter().all(|e| e.kind == EdgeKind::Import));
        assert!(
            !d.node_ids.contains(&NodeId("fnA2".into())),
            "kind-filtered-out endpoints are excluded"
        );
    }

    #[test]
    fn edge_detail_scopes_both_endpoints_to_their_subtrees() {
        // fnA1 -> fnA2 lives entirely inside fileA: it contributes to the
        // fileA -> fileA drill-in but never to fileA -> fileB.
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnA2", EdgeKind::FunctionCall));
        g.add_edge(edge("fnA2", "fnB1", EdgeKind::FunctionCall));

        let cross = detail(&g, "fileA", "fileB");
        assert_eq!(edge_pairs(&cross), [("fnA2", "fnB1")].into_iter().collect());

        let internal = detail(&g, "fileA", "fileA");
        assert_eq!(
            edge_pairs(&internal),
            [("fnA1", "fnA2")].into_iter().collect()
        );
    }

    #[test]
    fn edge_detail_scopes_to_transitive_descendants() {
        // Querying the root container picks up edges nested two levels down.
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));

        let d = detail(&g, "root", "root");
        assert_eq!(edge_pairs(&d), [("fnA1", "fnB1")].into_iter().collect());
    }

    #[test]
    fn edge_detail_includes_container_chain_of_every_endpoint() {
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));

        let d = detail(&g, "fileA", "fileB");
        let ids: HashSet<&str> = d.node_ids.iter().map(|id| id.0.as_str()).collect();
        assert!(ids.contains("fnA1"));
        assert!(ids.contains("fnB1"));
        assert!(ids.contains("fileA"), "container of fnA1");
        assert!(ids.contains("fileB"), "container of fnB1");
        assert!(ids.contains("root"), "root of the container chain");
        assert!(
            !ids.contains("fnA2"),
            "unrelated siblings are not part of the drill-in"
        );
    }

    #[test]
    fn edge_detail_with_no_contributing_edges_is_empty_not_none() {
        // Known endpoints with nothing between them: a well-formed empty detail.
        let g = sample_graph();
        let d = detail(&g, "fileA", "fileB");
        assert!(d.edges.is_empty());
        assert!(d.node_ids.is_empty());
    }

    // --- Cached parent map: consistency across every mutation path ---

    fn parents(g: &CodeGraph) -> Vec<(String, String)> {
        let mut pairs: Vec<(String, String)> = g
            .parent_map()
            .iter()
            .map(|(child, parent)| (child.0.clone(), parent.0.clone()))
            .collect();
        pairs.sort();
        pairs
    }

    /// The cached map must equal one built from scratch off the same nodes.
    fn assert_parent_map_matches_rebuild(g: &CodeGraph) {
        let mut expected: Vec<(String, String)> = Vec::new();
        for (node_id, node) in g.nodes.iter() {
            for child in node.children() {
                expected.push((child.0.clone(), node_id.0.clone()));
            }
        }
        expected.sort();
        assert_eq!(parents(g), expected);
    }

    #[test]
    fn parent_map_is_cached_after_first_use() {
        let g = sample_graph();
        assert!(!g.nodes.parent_map_is_cached(), "not built until asked for");
        let first = g.parent_map() as *const _;
        assert!(g.nodes.parent_map_is_cached());
        let second = g.parent_map() as *const _;
        assert_eq!(first, second, "second call reuses the cached map");
    }

    #[test]
    fn parent_map_cache_survives_edge_additions() {
        let mut g = sample_graph();
        let before = parents(&g);
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));
        assert!(
            g.nodes.parent_map_is_cached(),
            "edges do not touch the containment hierarchy"
        );
        assert_eq!(parents(&g), before);
    }

    #[test]
    fn parent_map_cache_invalidated_by_node_addition() {
        let mut g = sample_graph();
        let _ = g.parent_map(); // prime the cache
        g.add_node(block("fnB2", "fileB"));
        g.add_node(file("fileC", vec!["fnC1"]));
        g.add_node(block("fnC1", "fileC"));

        assert_eq!(
            g.parent_map().get(&NodeId("fnC1".into())),
            Some(&NodeId("fileC".into())),
            "a node added after the cache was built is in the map"
        );
        assert_parent_map_matches_rebuild(&g);
    }

    #[test]
    fn parent_map_cache_invalidated_by_children_mutation() {
        let mut g = sample_graph();
        let _ = g.parent_map(); // prime the cache
        g.add_node(block("fnA3", "fileA"));
        // The parse merge loop pushes block ids onto the file's children through
        // a `get_mut` -- the mutation path that must invalidate the cache.
        g.nodes
            .get_mut(&NodeId("fileA".into()))
            .unwrap()
            .children_mut()
            .push(NodeId("fnA3".into()));

        assert_eq!(
            g.parent_map().get(&NodeId("fnA3".into())),
            Some(&NodeId("fileA".into()))
        );
        assert_parent_map_matches_rebuild(&g);
    }

    #[test]
    fn parent_map_cache_invalidated_by_node_removal() {
        let mut g = sample_graph();
        let _ = g.parent_map(); // prime the cache
        // The re-parse strip: drop every code block, then drop their ids from
        // the files' children arrays.
        g.nodes.retain(|_, node| !node.is_code_block());
        for node in g.nodes.values_mut() {
            node.children_mut().retain(|child| !child.0.starts_with("fn"));
        }

        assert!(
            g.parent_map().get(&NodeId("fnA1".into())).is_none(),
            "a removed node has no parent entry"
        );
        assert_parent_map_matches_rebuild(&g);
    }

    #[test]
    fn subgraph_is_unchanged_by_the_parent_map_cache() {
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));
        let render: Vec<NodeId> = ["fileA", "fileB"]
            .iter()
            .map(|s| NodeId(s.to_string()))
            .collect();

        // Same graph, three calls: the cache must not drift.
        let first = format!("{:?}", SubGraph::from_graph(&g, &render, &all_kinds()));
        let second = format!("{:?}", SubGraph::from_graph(&g, &render, &all_kinds()));
        assert_eq!(first, second);

        // Mutate after the cache was built, then compare against a graph built
        // in the mutated shape from scratch (which never had a stale cache).
        g.add_node(block("fnB2", "fileB"));
        g.nodes
            .get_mut(&NodeId("fileB".into()))
            .unwrap()
            .children_mut()
            .push(NodeId("fnB2".into()));
        g.add_edge(edge("fnA2", "fnB2", EdgeKind::FunctionCall));

        let mut fresh = CodeGraph::new(NodeId("root".into()));
        fresh.add_node(dir("root", vec!["fileA", "fileB"]));
        fresh.add_node(file("fileA", vec!["fnA1", "fnA2"]));
        fresh.add_node(file("fileB", vec!["fnB1", "fnB2"]));
        fresh.add_node(block("fnA1", "fileA"));
        fresh.add_node(block("fnA2", "fileA"));
        fresh.add_node(block("fnB1", "fileB"));
        fresh.add_node(block("fnB2", "fileB"));
        fresh.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));
        fresh.add_edge(edge("fnA2", "fnB2", EdgeKind::FunctionCall));

        assert_eq!(
            format!("{:?}", SubGraph::from_graph(&g, &render, &all_kinds())),
            format!("{:?}", SubGraph::from_graph(&fresh, &render, &all_kinds())),
        );
    }

    #[test]
    fn neighborhood_and_edge_detail_see_post_mutation_containment() {
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));
        // Prime the cache through a real query.
        let _ = g.neighborhood(&NodeId("fnA1".into()), 1, &all_kinds(), FocusDirection::Both);

        // Re-parent fnB1 under a new file that did not exist when the cache was built.
        g.add_node(file("fileC", vec!["fnB1"]));
        g.nodes
            .get_mut(&NodeId("fileB".into()))
            .unwrap()
            .children_mut()
            .clear();

        let n = g
            .neighborhood(&NodeId("fnA1".into()), 1, &all_kinds(), FocusDirection::Both)
            .unwrap();
        let ids: HashSet<&str> = n.node_ids.iter().map(|id| id.0.as_str()).collect();
        assert!(ids.contains("fileC"), "container chain follows the new parent");
        assert!(!ids.contains("fileB"), "the old parent is no longer a container");

        let d = detail(&g, "fileA", "fileC");
        assert_eq!(edge_pairs(&d), [("fnA1", "fnB1")].into_iter().collect());
    }

    // --- Slim wire format + on-demand node details ---

    fn slim_block_json(g: &CodeGraph, id: &str) -> serde_json::Value {
        let result = ParseResult::from_graph(g);
        let value = serde_json::to_value(&result).expect("ParseResult serializes");
        value["nodes"][id].clone()
    }

    #[test]
    fn parse_result_omits_signature_from_blocks() {
        let mut g = sample_graph();
        g.add_node(CodeNode::CodeBlock {
            id: NodeId("fnA1".into()),
            name: "fnA1".into(),
            kind: BlockKind::Function,
            span: Span {
                start_line: 3,
                start_col: 0,
                end_line: 9,
                end_col: 1,
            },
            signature: Some("def fnA1(self, a, b, c):".into()),
            visibility: Some(Visibility::Public),
            parent: NodeId("fileA".into()),
            children: Vec::new(),
        });

        let block = slim_block_json(&g, "fnA1");
        assert!(
            block.get("signature").is_none(),
            "signature is panel-only and must not ship in the bulk payload"
        );
        // Everything the canvas/sidebar/containment tree reads is still there.
        assert_eq!(block["type"], "CodeBlock");
        assert_eq!(block["id"], "fnA1");
        assert_eq!(block["name"], "fnA1");
        assert_eq!(block["kind"], "Function");
        assert_eq!(block["visibility"], "Public");
        assert_eq!(block["parent"], "fileA");
        assert_eq!(block["span"]["start_line"], 3);
        assert_eq!(block["span"]["end_line"], 9);
        assert!(block["children"].is_array());
    }

    #[test]
    fn parse_result_keeps_directory_and_file_shape() {
        let g = sample_graph();
        let value = serde_json::to_value(ParseResult::from_graph(&g)).unwrap();

        assert_eq!(value["root"], "root");
        assert_eq!(value["edge_count"], 0);
        let dir = &value["nodes"]["root"];
        assert_eq!(dir["type"], "Directory");
        assert_eq!(dir["path"], "root");
        assert_eq!(dir["children"][0], "fileA");
        let file = &value["nodes"]["fileA"];
        assert_eq!(file["type"], "File");
        assert_eq!(file["language"], "Python");
        assert_eq!(file["path"], "fileA");
    }

    #[test]
    fn parse_response_serializes_identically_to_parse_result() {
        let mut g = sample_graph();
        g.add_edge(edge("fnA1", "fnB1", EdgeKind::FunctionCall));
        let expected = serde_json::to_value(ParseResult::from_graph(&g)).unwrap();
        let response = ParseResponse(std::sync::Arc::new(g));
        assert_eq!(serde_json::to_value(&response).unwrap(), expected);
    }

    #[test]
    fn node_details_carries_the_signature_left_out_of_the_payload() {
        let mut g = sample_graph();
        g.add_node(CodeNode::CodeBlock {
            id: NodeId("fnA1".into()),
            name: "fnA1".into(),
            kind: BlockKind::Function,
            span: Span {
                start_line: 1,
                start_col: 0,
                end_line: 1,
                end_col: 0,
            },
            signature: Some("def fnA1():".into()),
            visibility: Some(Visibility::Public),
            parent: NodeId("fileA".into()),
            children: Vec::new(),
        });

        let details = NodeDetails::from_graph(&g, &NodeId("fnA1".into())).unwrap();
        assert_eq!(details.id, NodeId("fnA1".into()));
        assert_eq!(details.signature.as_deref(), Some("def fnA1():"));

        // Files and directories carry no signature; unknown ids have no details.
        assert_eq!(
            NodeDetails::from_graph(&g, &NodeId("fileA".into()))
                .unwrap()
                .signature,
            None
        );
        assert!(NodeDetails::from_graph(&g, &NodeId("nope".into())).is_none());
    }
}
