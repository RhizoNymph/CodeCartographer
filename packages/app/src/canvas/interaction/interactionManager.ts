import type { Container, FederatedPointerEvent } from "pixi.js";

export interface DragState {
  nodeId: string;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
}

export class InteractionManager {
  private dragState: DragState | null = null;
  private onNodeMoved: ((nodeId: string, x: number, y: number) => void) | null = null;

  setOnNodeMoved(cb: (nodeId: string, x: number, y: number) => void) {
    this.onNodeMoved = cb;
  }

  startDrag(
    nodeId: string,
    container: Container,
    event: FederatedPointerEvent
  ) {
    this.dragState = {
      nodeId,
      startX: container.x,
      startY: container.y,
      offsetX: event.globalX - container.x,
      offsetY: event.globalY - container.y,
    };
  }

  updateDrag(event: FederatedPointerEvent, container: Container) {
    if (!this.dragState) return;

    const newX = event.globalX - this.dragState.offsetX;
    const newY = event.globalY - this.dragState.offsetY;

    container.x = newX;
    container.y = newY;
  }

  endDrag(container: Container) {
    if (!this.dragState) return;

    if (this.onNodeMoved) {
      this.onNodeMoved(this.dragState.nodeId, container.x, container.y);
    }

    this.dragState = null;
  }

  isDragging(): boolean {
    return this.dragState !== null;
  }

  getDragNodeId(): string | null {
    return this.dragState?.nodeId ?? null;
  }
}
