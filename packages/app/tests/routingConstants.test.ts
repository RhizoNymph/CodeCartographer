import assert from "node:assert/strict";
import test from "node:test";

import {
  BOUNDARY_TOLERANCE,
  DETOUR_GUTTER,
  MAX_LEAD_DISTANCE,
  MAX_OBSTACLE_REROUTE_PASSES,
  MIN_LEAD_DISTANCE,
  NODE_MOVED_EPSILON,
  NODE_OBSTACLE_MARGIN,
  OBSTACLE_QUERY_ALLOWANCE,
  OBSTACLE_QUERY_MARGIN,
  POINT_TOLERANCE,
} from "../src/canvas/layout/routingConstants.ts";

/**
 * The routing constants are one module so the pipeline's stages cannot disagree
 * about them, and the DERIVED ones are arithmetic so they cannot drift apart.
 * These tests pin the relationships, not just the numbers.
 */

test("OBSTACLE_QUERY_MARGIN is derived, not written out", () => {
  assert.equal(
    OBSTACLE_QUERY_MARGIN,
    NODE_OBSTACLE_MARGIN + DETOUR_GUTTER + OBSTACLE_QUERY_ALLOWANCE
  );
});

test("the obstacle query window covers everything a detour can reach", () => {
  // A detour clears an obstacle inflated by NODE_OBSTACLE_MARGIN and may be
  // pushed a further DETOUR_GUTTER outside it. Anything the router can reach but
  // the query cannot see is an obstacle it will happily route straight through.
  assert.ok(
    OBSTACLE_QUERY_MARGIN > NODE_OBSTACLE_MARGIN + DETOUR_GUTTER,
    "query window must exceed the inflation plus the gutter"
  );
  assert.ok(OBSTACLE_QUERY_ALLOWANCE > 0, "the slack must be a positive allowance");
});

test("OBSTACLE_QUERY_MARGIN still evaluates to the shipped 160", () => {
  // Guards the arithmetic itself: the parts may be re-explained, but changing
  // the query window is a routing-behaviour change and should be deliberate.
  assert.equal(OBSTACLE_QUERY_MARGIN, 160);
});

test("the tolerances are ordered from point equality up to routing clearances", () => {
  assert.ok(
    POINT_TOLERANCE < BOUNDARY_TOLERANCE,
    "point equality must be tighter than boundary containment"
  );
  assert.ok(
    BOUNDARY_TOLERANCE < NODE_OBSTACLE_MARGIN,
    "boundary containment must be tighter than obstacle clearance"
  );
  assert.ok(
    NODE_OBSTACLE_MARGIN < DETOUR_GUTTER,
    "an edge pushed outside a box must clear it by more than it hugs it"
  );
});

test("a node counts as dragged only past a whole layout unit", () => {
  // Sub-unit drift is float noise from the layout round trip; reacting to it
  // would re-route every edge on every redraw.
  assert.ok(NODE_MOVED_EPSILON > POINT_TOLERANCE);
  assert.ok(NODE_MOVED_EPSILON < NODE_OBSTACLE_MARGIN);
});

test("lead distances form a usable range and the reroute cap terminates", () => {
  assert.ok(MIN_LEAD_DISTANCE > 0);
  assert.ok(MAX_LEAD_DISTANCE > MIN_LEAD_DISTANCE);
  assert.ok(Number.isInteger(MAX_OBSTACLE_REROUTE_PASSES));
  assert.ok(MAX_OBSTACLE_REROUTE_PASSES > 0, "the router must be bounded");
});
