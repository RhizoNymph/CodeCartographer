use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
pub enum ParseError {
    #[error("Path does not exist: {0}")]
    PathNotFound(String),
    #[error("Failed to deserialize graph: {0}")]
    Deserialization(String),
    #[error("Parse error in file {file}: {message}")]
    FileParseFailed { file: String, message: String },
}
