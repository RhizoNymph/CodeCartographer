use cc_core::model::{BlockKind, CodeNode, Language, Visibility};
use cc_core::parser::Extractor;

fn extract(source: &str, lang: &Language) -> (Vec<CodeNode>, Vec<cc_core::parser::RawReference>) {
    Extractor::extract_file("test.file", source, lang).expect("extraction should succeed")
}

fn find_block<'a>(nodes: &'a [CodeNode], name: &str) -> &'a CodeNode {
    nodes
        .iter()
        .find(|n| {
            if let CodeNode::CodeBlock { name: n_name, .. } = n {
                n_name == name
            } else {
                false
            }
        })
        .unwrap_or_else(|| panic!("no code block named '{}'", name))
}

#[test]
fn test_rust_pub_crate_visibility() {
    // Parse: pub(crate) fn foo() {}
    // Verify the extracted CodeBlock has Visibility::Crate
    let source = "pub(crate) fn foo() {}";
    let (nodes, _) = extract(source, &Language::Rust);
    let block = find_block(&nodes, "foo");
    if let CodeNode::CodeBlock { visibility, .. } = block {
        assert_eq!(
            *visibility,
            Some(Visibility::Crate),
            "pub(crate) should map to Visibility::Crate"
        );
    } else {
        panic!("expected CodeBlock");
    }
}

#[test]
fn test_rust_pub_super_visibility() {
    // Parse: pub(super) fn bar() {}
    // Verify Visibility::Protected (reusing Protected for pub(super))
    let source = "pub(super) fn bar() {}";
    let (nodes, _) = extract(source, &Language::Rust);
    let block = find_block(&nodes, "bar");
    if let CodeNode::CodeBlock { visibility, .. } = block {
        assert_eq!(
            *visibility,
            Some(Visibility::Protected),
            "pub(super) should map to Visibility::Protected"
        );
    } else {
        panic!("expected CodeBlock");
    }
}

#[test]
fn test_python_classify_function() {
    // Parse: def hello(): pass
    // Verify BlockKind::Function is extracted
    let source = "def hello(): pass";
    let (nodes, _) = extract(source, &Language::Python);
    let block = find_block(&nodes, "hello");
    if let CodeNode::CodeBlock { kind, name, .. } = block {
        assert_eq!(*kind, BlockKind::Function);
        assert_eq!(name, "hello");
    } else {
        panic!("expected CodeBlock");
    }
}

#[test]
fn test_typescript_classify_interface() {
    // Parse: interface Foo { bar: string; }
    // Verify BlockKind::Interface is extracted
    let source = "interface Foo { bar: string; }";
    let (nodes, _) = extract(source, &Language::TypeScript);
    let block = find_block(&nodes, "Foo");
    if let CodeNode::CodeBlock { kind, name, .. } = block {
        assert_eq!(*kind, BlockKind::Interface);
        assert_eq!(name, "Foo");
    } else {
        panic!("expected CodeBlock");
    }
}
