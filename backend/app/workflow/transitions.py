"""SCM workflow state-machine transitions.

Created 2026-04-30 as part of the BHSPL SCM workflow rebuild.

This module is the single source of truth for which status transitions
are valid for each workflow entity. Endpoints call ``assert_transition``
before mutating any document's status; tests cover the full graph.

Public API: is_valid_transition, assert_transition, InvalidTransition.
Other names are private and may change without notice.

Entities and their state machines:

  indent_line       - the per-line ``IndentItem.fulfillment_status`` walks
                     either Flow 1 (in stock) or Flow 2 (procure -> GRN ->
                     putaway -> rejoin Flow 1) before settling on
                     ``acknowledged``.

  picking_order     - Store Keeper opens a picking order, walks the
                     warehouse picking, then completes it.

  packing_order     - Store Keeper opens a packing order against a
                     completed picking order, packs items, generates
                     outward barcodes, then completes it.

  mr_bucket         - Wh-mgr "procure" decision lands a bucket in
                     ``pooled``. The MRP runner pulls pooled buckets,
                     marks them ``in_run`` while creating draft MRs,
                     then finalises them as ``in_mr``.
"""
from types import MappingProxyType
from typing import FrozenSet, Mapping


class InvalidTransition(ValueError):
    """Raised when an entity status transition is not allowed."""
    pass


# Terminal states are keys mapped to frozenset() so that _GRAPH[e].keys()
# enumerates every reachable status for the entity.
_GRAPH_RAW = {
    'indent_line': {
        'pending':         frozenset({'reserved', 'in_mr_bucket'}),
        'reserved':        frozenset({'picking', 'pending'}),       # release back on timeout
        'in_mr_bucket':    frozenset({'in_mr_draft'}),
        'in_mr_draft':     frozenset({'in_po'}),
        'in_po':           frozenset({'awaiting_inward'}),
        'awaiting_inward': frozenset({'inward_received'}),
        'inward_received': frozenset({'reserved'}),                 # rejoin Flow 1
        'picking':         frozenset({'picked'}),
        'picked':          frozenset({'packed'}),
        'packed':          frozenset({'qc_passed'}),
        'qc_passed':       frozenset({'at_gate'}),
        'at_gate':         frozenset({'in_transit'}),
        'in_transit':      frozenset({'delivered'}),
        'delivered':       frozenset({'acknowledged'}),
        'acknowledged':    frozenset(),                             # terminal
    },
    'picking_order': {
        'draft':     frozenset({'picking', 'cancelled'}),
        'picking':   frozenset({'picked', 'cancelled'}),
        'picked':    frozenset(),
        'cancelled': frozenset(),
    },
    'packing_order': {
        'draft':     frozenset({'packing', 'cancelled'}),
        'packing':   frozenset({'packed', 'cancelled'}),
        'packed':    frozenset(),
        'cancelled': frozenset(),
    },
    'mr_bucket': {
        'pooled': frozenset({'in_run'}),
        'in_run': frozenset({'in_mr'}),
        'in_mr':  frozenset(),
    },
}

# Read-only views to prevent runtime mutation
_GRAPH: Mapping[str, Mapping[str, FrozenSet[str]]] = MappingProxyType({
    e: MappingProxyType(g) for e, g in _GRAPH_RAW.items()
})

# Precompute full status set per entity for O(1) unknown-status checks
_KNOWN: Mapping[str, FrozenSet[str]] = MappingProxyType({
    e: frozenset(set(g) | {t for outs in g.values() for t in outs})
    for e, g in _GRAPH_RAW.items()
})


def is_valid_transition(entity: str, from_status: str, to_status: str) -> bool:
    """Return True iff (from_status -> to_status) is in the entity's graph.

    Raises ``InvalidTransition`` if the entity, from_status, or to_status
    is unknown - calling code should not accidentally pass typos.
    """
    if entity not in _GRAPH:
        raise InvalidTransition(f'unknown entity: {entity!r}')
    known = _KNOWN[entity]
    if from_status not in known:
        raise InvalidTransition(
            f'unknown from_status {from_status!r} for entity {entity!r}')
    if to_status not in known:
        raise InvalidTransition(
            f'unknown to_status {to_status!r} for entity {entity!r}')
    return to_status in _GRAPH[entity].get(from_status, frozenset())


def assert_transition(entity: str, from_status: str, to_status: str) -> None:
    """Raise ``InvalidTransition`` if (from_status -> to_status) is disallowed."""
    if not is_valid_transition(entity, from_status, to_status):
        raise InvalidTransition(
            f'{entity}: cannot transition {from_status!r} -> {to_status!r}')
