import RBush from "rbush";

interface BBoxItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  nodeId: string;
}

/**
 * Frustum culling manager using an R-tree for O(log n) viewport queries.
 */
export class CullingManager {
  private tree = new RBush<BBoxItem>();
  private items = new Map<string, BBoxItem>();

  clear() {
    this.tree.clear();
    this.items.clear();
  }

  /**
   * Insert or update a node's bounding box.
   */
  upsert(nodeId: string, x: number, y: number, width: number, height: number) {
    const existing = this.items.get(nodeId);
    if (existing) {
      this.tree.remove(existing);
    }

    const item: BBoxItem = {
      minX: x,
      minY: y,
      maxX: x + width,
      maxY: y + height,
      nodeId,
    };

    this.items.set(nodeId, item);
    this.tree.insert(item);
  }

  remove(nodeId: string) {
    const existing = this.items.get(nodeId);
    if (existing) {
      this.tree.remove(existing);
      this.items.delete(nodeId);
    }
  }

  /**
   * Query which nodes are visible within the given viewport bounds.
   */
  queryViewport(
    viewX: number,
    viewY: number,
    viewWidth: number,
    viewHeight: number
  ): string[] {
    const results = this.tree.search({
      minX: viewX,
      minY: viewY,
      maxX: viewX + viewWidth,
      maxY: viewY + viewHeight,
    });

    return results.map((r) => r.nodeId);
  }

  get size(): number {
    return this.items.size;
  }
}
