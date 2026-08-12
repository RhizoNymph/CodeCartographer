#!/usr/bin/env python3
"""Deterministically generate a synthetic Python (+ optional TypeScript) repo.

The end-to-end harness (`crates/cc-core/examples/perf_harness.rs`) needs an
input repo that is (a) big enough for the pipeline costs to dominate noise and
(b) BYTE-IDENTICAL between two checkouts, so the same harness run on `main` and
on a feature branch is comparing the same work. Everything here is driven by a
single seeded `random.Random`, and the file order is fixed, so a given
(seed, files, depth, hub_fraction, ts_fraction) tuple always produces the same
tree.

Shape knobs that matter for what the benchmarks measure:

- `--files` / `--depth`: node and directory-chain counts, which drive scan cost,
  the size of the child -> parent map, and how far edge endpoints have to be
  lifted when containers are collapsed.
- `--hub-fraction`: the share of modules that define the SAME hub names
  (`get`, `run`, `handle`, `new`, `__init__`). Those names are what push symbol
  resolution into its ambiguous tiers, which is the path the early-bail change
  in the perf work targets. At 0.0 every symbol is unique and resolution is
  trivially cheap; at 0.6 a hub name has hundreds of global definitions.
- `--imports-per-file`: cross-module import + call density, i.e. edge count.

Usage:

    python3 benchmarks/gen_repo.py --preset medium --out "$TMPDIR/cc-bench-medium"
    python3 benchmarks/gen_repo.py --files 500 --depth 3 --hub-fraction 0.5 \
        --out /path/to/repo

Never generates into the repository itself: `--out` is required (the presets
only pick sizes, not locations).
"""

from __future__ import annotations

import argparse
import random
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

# Names deliberately shared by many modules. These are the ones that make a
# global symbol lookup return hundreds of candidates.
HUB_FUNCTIONS = ["run", "build", "handle", "process"]
HUB_METHODS = ["__init__", "get", "new", "update", "close"]

PRESETS = {
    "small": dict(files=200, depth=3, imports_per_file=3, hub_fraction=0.5),
    "medium": dict(files=2000, depth=4, imports_per_file=4, hub_fraction=0.5),
    "large": dict(files=10000, depth=5, imports_per_file=4, hub_fraction=0.5),
}


@dataclass(frozen=True)
class Module:
    """One generated module: where it lives and whether it defines hub names."""

    index: int
    package: tuple[str, ...]
    name: str
    is_hub: bool
    is_ts: bool

    @property
    def rel_path(self) -> Path:
        suffix = ".ts" if self.is_ts else ".py"
        return Path(*self.package) / f"{self.name}{suffix}"

    @property
    def dotted(self) -> str:
        """Python import path (`pkg_0.pkg_3.mod_17`)."""
        return ".".join([*self.package, self.name])


def build_package_tree(rng: random.Random, depth: int, count: int) -> list[tuple[str, ...]]:
    """Return `count` package paths, at most `depth` levels deep.

    Built breadth-first from a fixed branching factor so the directory tree is
    bushy rather than a single chain: real repos have a handful of top-level
    packages and progressively fewer deep ones.
    """
    packages: list[tuple[str, ...]] = [()]
    frontier: list[tuple[str, ...]] = [()]
    branching = 4
    next_id = 0

    while len(packages) < count and frontier:
        parent = frontier.pop(0)
        if len(parent) >= depth:
            continue
        for _ in range(branching):
            if len(packages) >= count:
                break
            child = (*parent, f"pkg_{next_id}")
            next_id += 1
            packages.append(child)
            frontier.append(child)

    # Shuffle only the ORDER modules are assigned to packages, not the set, so
    # the tree shape is stable while file placement still looks irregular.
    rng.shuffle(packages)
    return packages


def plan_modules(
    rng: random.Random, files: int, depth: int, hub_fraction: float, ts_fraction: float
) -> list[Module]:
    package_count = max(1, files // 6)
    packages = build_package_tree(rng, depth, package_count)

    modules: list[Module] = []
    for i in range(files):
        package = packages[i % len(packages)]
        is_hub = rng.random() < hub_fraction
        is_ts = rng.random() < ts_fraction
        modules.append(
            Module(index=i, package=package, name=f"mod_{i}", is_hub=is_hub, is_ts=is_ts)
        )
    return modules


def pick_imports(rng: random.Random, modules: list[Module], me: Module, k: int) -> list[Module]:
    """`k` distinct other modules for `me` to import, chosen deterministically."""
    if len(modules) <= 1 or k <= 0:
        return []
    picked: list[Module] = []
    seen = {me.index}
    for _ in range(k * 3):
        if len(picked) >= k:
            break
        candidate = modules[rng.randrange(len(modules))]
        if candidate.index in seen or candidate.is_ts != me.is_ts:
            continue
        seen.add(candidate.index)
        picked.append(candidate)
    return picked


def python_module_source(module: Module, imports: list[Module]) -> str:
    i = module.index
    lines: list[str] = [f'"""Generated module {module.dotted}."""', "", "import os", "import sys"]

    for dep in imports:
        lines.append(f"from {dep.dotted} import Widget{dep.index}, make_{dep.index}")
    lines.append("")
    lines.append("")

    # Class with either hub method names or module-unique ones.
    methods = HUB_METHODS if module.is_hub else [f"{m}_{i}" for m in HUB_METHODS]
    lines.append(f"class Widget{i}:")
    lines.append(f'    """Widget defined by {module.dotted}."""')
    lines.append("")
    for method in methods:
        if method == "__init__":
            lines.append("    def __init__(self, name=None):")
            lines.append("        self.name = name")
            lines.append("        self.items = []")
        elif method.startswith("__init__"):
            # Unique-name variant of the constructor for non-hub modules.
            lines.append("    def __init__(self, name=None):")
            lines.append("        self.name = name")
            lines.append("        self.items = []")
        else:
            lines.append(f"    def {method}(self, value=None):")
            lines.append("        if value is not None:")
            lines.append("            self.items.append(value)")
            lines.append("        return self.items")
        lines.append("")

    # Free functions: hub-named for hub modules, unique otherwise.
    functions = HUB_FUNCTIONS if module.is_hub else [f"{f}_{i}" for f in HUB_FUNCTIONS]
    for func in functions:
        lines.append(f"def {func}(source=None):")
        lines.append(f"    widget = Widget{i}(source)")
        lines.append("    widget.items.append(source)")
        lines.append("    return widget")
        lines.append("")

    # A unique factory every importer can call, so imports produce call edges
    # rather than dangling names.
    lines.append(f"def make_{i}(source=None):")
    lines.append(f"    return Widget{i}(source)")
    lines.append("")

    # Call sites into the imported modules: this is what makes the resolver do
    # real work, and (for hub names) what drives it into the ambiguous tiers.
    lines.append(f"def wire_{i}(payload):")
    lines.append("    results = []")
    for dep in imports:
        lines.append(f"    results.append(make_{dep.index}(payload))")
        lines.append(f"    results.append(Widget{dep.index}(payload))")
    for func in HUB_FUNCTIONS:
        lines.append(f"    results.append({func}(payload))")
    lines.append("    return results")
    lines.append("")

    # Hub-name call sites. In a HUB module these resolve same-file (tier 1, the
    # cheap path); everywhere else they hit the global tiers, where a name with
    # hundreds of definitions is exactly the ambiguity the resolver has to bail
    # out of. `--hub-fraction` therefore sets the ambiguous/cheap ratio.
    lines.append(f"def dispatch_{i}(payload):")
    lines.append("    out = []")
    for func in HUB_FUNCTIONS:
        lines.append(f"    out.append({func}(payload))")
    for dep in imports:
        for method in ("get", "update", "close"):
            lines.append(f"    out.append(make_{dep.index}(payload).{method}(payload))")
    lines.append("    return out")
    lines.append("")

    return "\n".join(lines)


def typescript_module_source(module: Module, imports: list[Module]) -> str:
    i = module.index
    lines: list[str] = [f"// Generated module {module.dotted}.", ""]

    for dep in imports:
        rel = relative_ts_import(module, dep)
        lines.append(f'import {{ Widget{dep.index}, make{dep.index} }} from "{rel}";')
    lines.append("")

    methods = HUB_METHODS if module.is_hub else [f"{m}_{i}" for m in HUB_METHODS]
    lines.append(f"export interface Spec{i} {{")
    lines.append("  name: string;")
    lines.append("  items: string[];")
    lines.append("}")
    lines.append("")
    lines.append(f"export class Widget{i} {{")
    lines.append("  items: string[] = [];")
    lines.append("")
    for method in methods:
        safe = method.replace("__init__", "init")
        lines.append(f"  {safe}(value?: string): string[] {{")
        lines.append("    if (value) this.items.push(value);")
        lines.append("    return this.items;")
        lines.append("  }")
        lines.append("")
    lines.append("}")
    lines.append("")

    functions = HUB_FUNCTIONS if module.is_hub else [f"{f}_{i}" for f in HUB_FUNCTIONS]
    for func in functions:
        lines.append(f"export function {func}(source: string): Widget{i} {{")
        lines.append(f"  const widget = new Widget{i}();")
        lines.append("  widget.items.push(source);")
        lines.append("  return widget;")
        lines.append("}")
        lines.append("")

    lines.append(f"export function make{i}(source: string): Widget{i} {{")
    lines.append(f"  const widget = new Widget{i}();")
    lines.append("  widget.items.push(source);")
    lines.append("  return widget;")
    lines.append("}")
    lines.append("")

    lines.append(f"export function wire{i}(payload: string): unknown[] {{")
    lines.append("  const results: unknown[] = [];")
    for dep in imports:
        lines.append(f"  results.push(make{dep.index}(payload));")
        lines.append(f"  results.push(new Widget{dep.index}());")
    lines.append("  return results;")
    lines.append("}")
    lines.append("")

    return "\n".join(lines)


def relative_ts_import(module: Module, dep: Module) -> str:
    """A `./`-prefixed relative specifier from `module` to `dep` (no extension)."""
    from_dir = Path(*module.package)
    to_path = Path(*dep.package) / dep.name
    up = len(from_dir.parts)
    rel = Path(*([".."] * up)) / to_path if up else to_path
    text = rel.as_posix()
    return text if text.startswith(".") else f"./{text}"


def generate(
    out: Path,
    files: int,
    depth: int,
    imports_per_file: int,
    hub_fraction: float,
    ts_fraction: float,
    seed: int,
    force: bool,
) -> dict[str, int]:
    if out.exists():
        if not force:
            raise SystemExit(
                f"{out} already exists; pass --force to regenerate it from scratch"
            )
        shutil.rmtree(out)

    rng = random.Random(seed)
    modules = plan_modules(rng, files, depth, hub_fraction, ts_fraction)

    # A second generator for import edges, seeded off the same seed, so changing
    # `--imports-per-file` does not perturb module placement.
    edge_rng = random.Random(seed ^ 0x5EED)

    packages_written: set[tuple[str, ...]] = set()
    hub_modules = 0
    ts_modules = 0

    for module in modules:
        target = out / module.rel_path
        target.parent.mkdir(parents=True, exist_ok=True)

        # Every Python package level needs an __init__.py to be importable.
        if not module.is_ts:
            for level in range(len(module.package) + 1):
                package = module.package[:level]
                if package in packages_written:
                    continue
                packages_written.add(package)
                init = out / Path(*package) / "__init__.py"
                init.parent.mkdir(parents=True, exist_ok=True)
                init.write_text(f'"""Package {".".join(package) or "root"}."""\n')

        imports = pick_imports(edge_rng, modules, module, imports_per_file)
        source = (
            typescript_module_source(module, imports)
            if module.is_ts
            else python_module_source(module, imports)
        )
        target.write_text(source)

        hub_modules += int(module.is_hub)
        ts_modules += int(module.is_ts)

    return {
        "modules": len(modules),
        "hub_modules": hub_modules,
        "ts_modules": ts_modules,
        "packages": len(packages_written),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True, type=Path, help="destination directory (must be outside the repo)")
    parser.add_argument("--preset", choices=sorted(PRESETS), help="size preset: small/medium/large")
    parser.add_argument("--files", type=int, help="number of modules to generate")
    parser.add_argument("--depth", type=int, help="maximum package nesting depth")
    parser.add_argument("--imports-per-file", type=int, help="cross-module imports per module")
    parser.add_argument(
        "--hub-fraction",
        type=float,
        help="share of modules defining the shared hub names (0.0-1.0)",
    )
    parser.add_argument(
        "--ts-fraction",
        type=float,
        default=0.0,
        help="share of modules emitted as TypeScript instead of Python",
    )
    parser.add_argument("--seed", type=int, default=20240611, help="RNG seed (default: 20240611)")
    parser.add_argument("--force", action="store_true", help="delete --out first if it exists")
    args = parser.parse_args(argv)

    settings = dict(PRESETS[args.preset]) if args.preset else dict(PRESETS["small"])
    for key in ("files", "depth", "imports_per_file", "hub_fraction"):
        value = getattr(args, key)
        if value is not None:
            settings[key] = value

    stats = generate(
        out=args.out,
        files=int(settings["files"]),
        depth=int(settings["depth"]),
        imports_per_file=int(settings["imports_per_file"]),
        hub_fraction=float(settings["hub_fraction"]),
        ts_fraction=args.ts_fraction,
        seed=args.seed,
        force=args.force,
    )

    print(
        f"generated {stats['modules']} modules "
        f"({stats['hub_modules']} hub-named, {stats['ts_modules']} TypeScript) "
        f"across {stats['packages']} packages into {args.out}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
