/**
 * Every tolerance and margin the edge-routing pipeline measures against, in one
 * place.
 *
 * These numbers used to be scattered across `edgeGeometry.ts` (geometry
 * tolerances, obstacle margins, pass caps) and `renderers/edgeDrawing.ts`
 * (a second, weaker point tolerance and the obstacle query window), where two
 * stages of the same pipeline could — and did — disagree about whether a point
 * sat on a box. Derived values are expressed as ARITHMETIC over the values they
 * derive from, so the relationship cannot drift the way a prose comment can.
 *
 * Dependency-free, so it loads under `node --test`.
 */

/**
 * When two coordinates count as the SAME coordinate.
 *
 * Sub-pixel: this is point equality (deduping, "is this segment axis-aligned",
 * "does this point lie on that box side"), never a judgement call about
 * proximity.
 */
export const POINT_TOLERANCE = 0.5;

/**
 * How far off a node's boundary a point may sit and still count as ON it.
 *
 * Wider than `POINT_TOLERANCE` because it absorbs the rounding ELK accumulates
 * while composing nested container offsets. Only used for containment-style
 * questions about a whole box, never for point equality.
 */
export const BOUNDARY_TOLERANCE = 4;

/**
 * How far a node's on-screen container may sit from its laid-out position
 * before the redraw treats it as DRAGGED.
 *
 * A whole layout unit: sub-unit drift is float noise from the layout round
 * trip, not a user moving a node, and reacting to it would re-route every edge
 * on every redraw.
 */
export const NODE_MOVED_EPSILON = 1;

/**
 * How far a routed edge stays clear of a node box it detours around.
 *
 * Obstacle boxes are inflated by this before any crossing test, so an edge that
 * "just" clears a node still reads as clearing it at normal zoom.
 */
export const NODE_OBSTACLE_MARGIN = 14;

/**
 * How far outside the involved boxes a detour is pushed when it has to leave
 * the corridor between the two endpoints entirely.
 *
 * Big enough that the detour reads as going AROUND the obstacle rather than
 * grazing it, small enough that it does not fly off across the canvas.
 */
export const DETOUR_GUTTER = 28;

/**
 * Hard cap on detour passes for a single edge.
 *
 * Each pass clears the first obstacle crossing it finds and re-normalises, so a
 * dense field of obstacles can need many. The cap is what makes the router
 * terminate: past it the edge is drawn with whatever crossings remain rather
 * than the redraw hanging.
 */
export const MAX_OBSTACLE_REROUTE_PASSES = 32;

/**
 * Slack added on top of the obstacle inflation and the detour gutter when
 * deciding which obstacles an edge can possibly care about.
 *
 * Covers a node's own extent (a tall node is ~72 units) plus room to spare, so
 * the query window is generous rather than exact — a missed obstacle is a
 * visible routing bug, an extra one costs a crossing test.
 */
export const OBSTACLE_QUERY_ALLOWANCE = 118;

/**
 * How far beyond an edge's own bounding box obstacles are still considered.
 *
 * The router may leave the corridor between the endpoints: a detour clears an
 * obstacle inflated by `NODE_OBSTACLE_MARGIN` and can be pushed a further
 * `DETOUR_GUTTER` outside the boxes it goes around, on top of a node's own
 * extent (`OBSTACLE_QUERY_ALLOWANCE`). Computed rather than written out so it
 * cannot fall behind the values it depends on, while keeping each query to a
 * handful of boxes instead of the whole graph.
 */
export const OBSTACLE_QUERY_MARGIN =
  NODE_OBSTACLE_MARGIN + DETOUR_GUTTER + OBSTACLE_QUERY_ALLOWANCE;

/** Shortest lead an edge is given before it may turn away from its anchor. */
export const MIN_LEAD_DISTANCE = 18;

/** Longest lead an edge is given before it may turn away from its anchor. */
export const MAX_LEAD_DISTANCE = 72;
