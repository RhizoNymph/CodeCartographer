"""Helper module reached through an absolute dotted import."""

from ..mod import Thing


def assist(label: str) -> str:
    return "assist:" + label + Thing().label()
