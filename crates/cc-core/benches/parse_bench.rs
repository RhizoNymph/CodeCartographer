use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};

use cc_core::model::Language;
use cc_core::parser::Extractor;

// ---------------------------------------------------------------------------
// Sample source snippets for each language.  These are large enough to
// exercise the tree-sitter parser and reference collector, but small enough
// to keep benchmark iteration time reasonable.
// ---------------------------------------------------------------------------

const PYTHON_SOURCE: &str = r##"
import os
import sys
from pathlib import Path
from collections import defaultdict

class FileProcessor:
    """Processes files in a directory tree."""

    def __init__(self, root: Path):
        self.root = root
        self._cache = defaultdict(list)

    def scan(self, pattern: str = "*.py"):
        for path in self.root.rglob(pattern):
            self._process_file(path)

    def _process_file(self, path: Path):
        content = path.read_text()
        lines = content.splitlines()
        self._cache[str(path)] = lines
        return self._analyze(lines)

    def _analyze(self, lines):
        stats = {
            "total": len(lines),
            "blank": sum(1 for l in lines if not l.strip()),
            "comment": sum(1 for l in lines if l.strip().startswith("#")),
        }
        return stats

class BatchProcessor(FileProcessor):
    def __init__(self, root: Path, workers: int = 4):
        super().__init__(root)
        self.workers = workers

    def run(self):
        results = []
        self.scan()
        for path, lines in self._cache.items():
            result = self._analyze(lines)
            results.append((path, result))
        return results

def main():
    processor = BatchProcessor(Path("."))
    results = processor.run()
    for path, stats in results:
        print(f"{path}: {stats}")

if __name__ == "__main__":
    main()
"##;

const TYPESCRIPT_SOURCE: &str = r##"
import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname, relative } from "path";

interface FileInfo {
  path: string;
  size: number;
  extension: string;
}

interface ScanResult {
  files: FileInfo[];
  totalSize: number;
}

type FilterFn = (info: FileInfo) => boolean;

enum FileCategory {
  Source = "source",
  Config = "config",
  Asset = "asset",
  Unknown = "unknown",
}

class DirectoryScanner {
  private root: string;
  private files: FileInfo[] = [];

  constructor(root: string) {
    this.root = root;
  }

  scan(filter?: FilterFn): ScanResult {
    this.walkDir(this.root);
    const filtered = filter ? this.files.filter(filter) : this.files;
    const totalSize = filtered.reduce((sum, f) => sum + f.size, 0);
    return { files: filtered, totalSize };
  }

  private walkDir(dir: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        this.walkDir(fullPath);
      } else {
        this.files.push({
          path: relative(this.root, fullPath),
          size: stat.size,
          extension: extname(fullPath),
        });
      }
    }
  }

  categorize(info: FileInfo): FileCategory {
    const ext = info.extension.toLowerCase();
    if ([".ts", ".js", ".py", ".rs"].includes(ext)) return FileCategory.Source;
    if ([".json", ".toml", ".yaml"].includes(ext)) return FileCategory.Config;
    if ([".png", ".svg", ".ico"].includes(ext)) return FileCategory.Asset;
    return FileCategory.Unknown;
  }
}

function createReport(result: ScanResult): string {
  const lines = result.files.map(
    (f) => `${f.path} (${f.size} bytes)`
  );
  lines.push(`Total: ${result.totalSize} bytes`);
  return lines.join("\n");
}

function main() {
  const scanner = new DirectoryScanner(".");
  const result = scanner.scan((f) => f.size > 0);
  const report = createReport(result);
  console.log(report);
}
"##;

const RUST_SOURCE: &str = r##"
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub struct FileEntry {
    pub path: PathBuf,
    pub size: u64,
    pub extension: Option<String>,
}

pub trait Analyzer {
    fn analyze(&self, entries: &[FileEntry]) -> AnalysisResult;
    fn name(&self) -> &str;
}

pub struct AnalysisResult {
    pub total_files: usize,
    pub total_size: u64,
    pub by_extension: HashMap<String, usize>,
}

pub struct DirectoryWalker {
    root: PathBuf,
    entries: Vec<FileEntry>,
}

impl DirectoryWalker {
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().to_path_buf(),
            entries: Vec::new(),
        }
    }

    pub fn walk(&mut self) -> &[FileEntry] {
        self.walk_dir(&self.root.clone());
        &self.entries
    }

    fn walk_dir(&mut self, dir: &Path) {
        let read_dir = match fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(_) => return,
        };

        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.is_dir() {
                self.walk_dir(&path);
            } else if let Ok(meta) = entry.metadata() {
                self.entries.push(FileEntry {
                    extension: path.extension().map(|e| e.to_string_lossy().to_string()),
                    path,
                    size: meta.len(),
                });
            }
        }
    }
}

struct SizeAnalyzer;

impl Analyzer for SizeAnalyzer {
    fn analyze(&self, entries: &[FileEntry]) -> AnalysisResult {
        let mut by_extension: HashMap<String, usize> = HashMap::new();
        let mut total_size = 0u64;

        for entry in entries {
            total_size += entry.size;
            let ext = entry
                .extension
                .as_deref()
                .unwrap_or("none")
                .to_string();
            *by_extension.entry(ext).or_default() += 1;
        }

        AnalysisResult {
            total_files: entries.len(),
            total_size,
            by_extension,
        }
    }

    fn name(&self) -> &str {
        "size_analyzer"
    }
}

pub fn run_analysis(root: &str) -> AnalysisResult {
    let mut walker = DirectoryWalker::new(root);
    let entries = walker.walk();
    let analyzer = SizeAnalyzer;
    analyzer.analyze(entries)
}
"##;

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

fn bench_extract_file(c: &mut Criterion) {
    let mut group = c.benchmark_group("extract_file");

    let cases: &[(&str, &str, Language)] = &[
        ("test.py", PYTHON_SOURCE, Language::Python),
        ("test.ts", TYPESCRIPT_SOURCE, Language::TypeScript),
        ("test.rs", RUST_SOURCE, Language::Rust),
    ];

    for (file, source, lang) in cases {
        group.bench_with_input(
            BenchmarkId::new("single", file),
            &(file, source, lang),
            |b, &(file, source, lang)| {
                b.iter(|| {
                    black_box(Extractor::extract_file(file, source, lang).unwrap());
                });
            },
        );
    }
    group.finish();
}

/// Benchmark parsing many files sequentially — directly measures the work
/// that PR D2 (rayon parallelisation) targets.  Run this bench on main vs
/// the PR branch to see the speedup.
fn bench_extract_many_files(c: &mut Criterion) {
    let mut group = c.benchmark_group("extract_many_files");
    // Simulate a project with N files (cycling through the 3 languages)
    for n in [10, 50, 100] {
        let files: Vec<(&str, &str, Language)> = (0..n)
            .map(|i| match i % 3 {
                0 => ("test.py", PYTHON_SOURCE, Language::Python),
                1 => ("test.ts", TYPESCRIPT_SOURCE, Language::TypeScript),
                _ => ("test.rs", RUST_SOURCE, Language::Rust),
            })
            .collect();

        group.bench_with_input(BenchmarkId::from_parameter(n), &files, |b, files| {
            b.iter(|| {
                let mut all_nodes = Vec::new();
                let mut all_refs = Vec::new();
                for (path, source, lang) in files {
                    let (nodes, refs) = Extractor::extract_file(path, source, lang).unwrap();
                    all_nodes.extend(nodes);
                    all_refs.extend(refs);
                }
                black_box((&all_nodes, &all_refs));
            });
        });
    }
    group.finish();
}

/// Benchmark the full pipeline: parse files → build symbol table → resolve
/// references → add edges to graph.
fn bench_full_pipeline(c: &mut Criterion) {
    use cc_core::model::{CodeGraph, CodeNode, NodeId};
    use cc_core::resolver::SymbolTable;

    let mut group = c.benchmark_group("full_pipeline");

    for n in [20, 50] {
        let sources: Vec<(String, &str, Language)> = (0..n)
            .map(|i| match i % 3 {
                0 => (format!("src/mod_{i}.py"), PYTHON_SOURCE, Language::Python),
                1 => (
                    format!("src/mod_{i}.ts"),
                    TYPESCRIPT_SOURCE,
                    Language::TypeScript,
                ),
                _ => (format!("src/mod_{i}.rs"), RUST_SOURCE, Language::Rust),
            })
            .collect();

        group.bench_with_input(BenchmarkId::from_parameter(n), &sources, |b, sources| {
            b.iter(|| {
                let mut graph = CodeGraph::new(NodeId("root".into()));

                // Add file nodes
                for (path, _, lang) in sources {
                    let lang_enum = Some(lang.clone());
                    let file_id = NodeId::file(path);
                    graph.add_node(CodeNode::File {
                        id: file_id,
                        name: path.clone(),
                        path: path.clone(),
                        language: lang_enum,
                        children: Vec::new(),
                    });
                }

                // Parse each file
                let mut all_refs = Vec::new();
                for (path, source, lang) in sources {
                    let (nodes, refs) = Extractor::extract_file(path, source, lang).unwrap();
                    let file_id = NodeId::file(path);
                    for node in nodes {
                        let block_id = node.id().clone();
                        graph.add_node(node);
                        if let Some(file_node) = graph.nodes.get_mut(&file_id) {
                            file_node.children_mut().push(block_id);
                        }
                    }
                    all_refs.extend(refs);
                }

                // Resolve references into edges
                let symbol_table = SymbolTable::build_from_graph(&graph);
                let edges = symbol_table.resolve_references(&all_refs);
                for edge in edges {
                    graph.add_edge(edge);
                }

                black_box(&graph);
            });
        });
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_extract_file,
    bench_extract_many_files,
    bench_full_pipeline,
);
criterion_main!(benches);
