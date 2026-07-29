"""Real source inside a package named `build`; must survive the scan."""


def build_thing() -> str:
    return "built"
