use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::env;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

const INDEX_HTML: &str = include_str!("../public/index.html");
const APP_JS: &str = include_str!("../public/app.js");
const STYLES_CSS: &str = include_str!("../public/styles.css");

#[derive(Debug)]
struct Note {
    filename: String,
    filename_stem: String,
    path: String,
    abs_path: String,
    title: String,
    raw_content: String,
    word_count: Option<u64>,
    modified: Option<String>,
    tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ZkGraph {
    notes: Vec<ZkNote>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZkNote {
    filename: String,
    filename_stem: String,
    path: String,
    abs_path: String,
    title: String,
    raw_content: String,
    word_count: Option<u64>,
    modified: Option<String>,
    tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ApiGraph {
    notebook: String,
    generated_at: String,
    nodes: Vec<ApiNode>,
    edges: Vec<ApiEdge>,
    stats: ApiStats,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiNode {
    id: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    abs_path: Option<String>,
    group: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    word_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ApiEdge {
    from: String,
    to: String,
    kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiStats {
    notes: usize,
    tags: usize,
    edges: usize,
    note_links: usize,
    tag_links: usize,
}

fn main() -> std::io::Result<()> {
    let port = env::var("PORT").unwrap_or_else(|_| "4174".to_string());
    let notebook = default_notebook();
    let stdin_mode = env::args().any(|arg| arg == "--stdin");
    let cached_graph = if stdin_mode {
        let mut input = String::new();
        io::stdin().read_to_string(&mut input)?;
        let graph = graph_from_zk_json(&notebook, &input)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        Some(graph)
    } else {
        None
    };

    let listener = TcpListener::bind(format!("127.0.0.1:{port}"))?;

    eprintln!("roam-graph-html rust prototype: http://127.0.0.1:{port}");
    if stdin_mode {
        eprintln!("input: zk JSON from stdin");
    } else {
        eprintln!("notebook: {}", notebook.display());
        eprintln!("source: external zk command from PATH");
    }

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => handle_connection(stream, &notebook, cached_graph.as_ref()),
            Err(error) => eprintln!("connection error: {error}"),
        }
    }

    Ok(())
}

fn default_notebook() -> PathBuf {
    if let Ok(path) = env::var("NOTEBOOK").or_else(|_| env::var("ZK_NOTEBOOK")) {
        return PathBuf::from(path);
    }
    let home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join("Documents/Nextcloud/Notes")
}

fn handle_connection(
    mut stream: TcpStream,
    default_notebook: &PathBuf,
    cached_graph: Option<&ApiGraph>,
) {
    let mut buffer = [0_u8; 8192];
    let read = match stream.read(&mut buffer) {
        Ok(read) => read,
        Err(error) => {
            eprintln!("read error: {error}");
            return;
        }
    };

    let request = String::from_utf8_lossy(&buffer[..read]);
    let first_line = request.lines().next().unwrap_or("");
    let Some((method, raw_path)) = parse_request_line(first_line) else {
        respond(
            &mut stream,
            400,
            "text/plain; charset=utf-8",
            b"Bad request",
        );
        return;
    };

    if method != "GET" {
        respond(
            &mut stream,
            405,
            "text/plain; charset=utf-8",
            b"Method not allowed",
        );
        return;
    }

    let (path, query) = split_path_query(raw_path);
    match path {
        "/" | "/index.html" => respond(
            &mut stream,
            200,
            "text/html; charset=utf-8",
            INDEX_HTML.as_bytes(),
        ),
        "/app.js" => respond(
            &mut stream,
            200,
            "text/javascript; charset=utf-8",
            APP_JS.as_bytes(),
        ),
        "/styles.css" => respond(
            &mut stream,
            200,
            "text/css; charset=utf-8",
            STYLES_CSS.as_bytes(),
        ),
        "/api/graph" => {
            let graph = if let Some(graph) = cached_graph {
                Ok(graph.clone())
            } else {
                let notebook = query_param(query, "notebook")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| default_notebook.clone());
                build_graph(&notebook)
            };
            match graph {
                Ok(graph) => {
                    let body = serde_json::to_vec(&graph).unwrap_or_else(|error| {
                        format!(r#"{{"error":"failed to serialize graph: {error}"}}"#).into_bytes()
                    });
                    respond(&mut stream, 200, "application/json; charset=utf-8", &body);
                }
                Err(error) => {
                    let body = serde_json::json!({ "error": error }).to_string();
                    respond(
                        &mut stream,
                        500,
                        "application/json; charset=utf-8",
                        body.as_bytes(),
                    );
                }
            }
        }
        _ => respond(&mut stream, 404, "text/plain; charset=utf-8", b"Not found"),
    }
}

fn parse_request_line(line: &str) -> Option<(&str, &str)> {
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    let path = parts.next()?;
    Some((method, path))
}

fn split_path_query(raw_path: &str) -> (&str, Option<&str>) {
    match raw_path.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (raw_path, None),
    }
}

fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    let query = query?;
    for pair in query.split('&') {
        let (raw_key, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
        if percent_decode(raw_key) == key {
            return Some(percent_decode(raw_value));
        }
    }
    None
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                if let Ok(hex) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                    out.push(hex);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
}

fn build_graph(notebook: &PathBuf) -> Result<ApiGraph, String> {
    let output = Command::new("zk")
        .args(["graph", "--format", "json", "--quiet"])
        .current_dir(notebook)
        .output()
        .map_err(|error| format!("failed to run zk: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("zk graph failed: {}", stderr.trim()));
    }

    let raw = String::from_utf8(output.stdout)
        .map_err(|error| format!("zk emitted non-UTF-8 output: {error}"))?;
    graph_from_zk_json(notebook, &raw)
}

fn graph_from_zk_json(notebook: &PathBuf, raw: &str) -> Result<ApiGraph, String> {
    let zk_graph: ZkGraph =
        serde_json::from_str(raw).map_err(|error| format!("failed to parse zk JSON: {error}"))?;
    Ok(convert_zk_graph(notebook, zk_graph))
}

fn convert_zk_graph(notebook: &PathBuf, zk_graph: ZkGraph) -> ApiGraph {
    let notes = zk_graph
        .notes
        .into_iter()
        .map(|note| Note {
            filename: note.filename,
            filename_stem: note.filename_stem,
            path: note.path,
            abs_path: note.abs_path,
            title: note.title,
            raw_content: note.raw_content,
            word_count: note.word_count,
            modified: note.modified,
            tags: note.tags,
        })
        .collect();
    convert_graph(notebook, notes)
}

fn convert_graph(notebook: &PathBuf, notes: Vec<Note>) -> ApiGraph {
    let mut by_exact: HashMap<String, String> = HashMap::new();
    let mut by_stem: HashMap<String, String> = HashMap::new();

    for note in &notes {
        by_exact.insert(note.path.clone(), note.path.clone());
        by_exact.insert(note.filename.clone(), note.path.clone());
        by_stem.insert(strip_md(&note.path), note.path.clone());
        by_stem.insert(note.filename_stem.clone(), note.path.clone());
    }

    let mut nodes = Vec::with_capacity(notes.len());
    let mut edge_map: BTreeMap<String, ApiEdge> = BTreeMap::new();
    let mut tags: BTreeSet<String> = BTreeSet::new();

    for note in &notes {
        nodes.push(ApiNode {
            id: note_id(&note.path),
            label: title_of(note),
            path: Some(note.path.clone()),
            abs_path: Some(note.abs_path.clone()),
            group: "note",
            word_count: note.word_count,
            modified: note.modified.clone(),
        });

        for tag in &note.tags {
            let clean = tag.trim_start_matches('#').to_string();
            if clean.is_empty() {
                continue;
            }
            tags.insert(clean.clone());
            let edge = ApiEdge {
                from: note_id(&note.path),
                to: tag_id(&clean),
                kind: "tag",
            };
            edge_map.insert(format!("{}--{}", edge.from, edge.to), edge);
        }

        for raw_target in markdown_targets(&note.raw_content) {
            if let Some(resolved) = resolve_target(&raw_target, &notes, &by_exact, &by_stem) {
                if resolved == note.path {
                    continue;
                }
                let from = note_id(&note.path);
                let to = note_id(&resolved);
                let key = if from < to {
                    format!("{from}--{to}")
                } else {
                    format!("{to}--{from}")
                };
                edge_map.insert(
                    key,
                    ApiEdge {
                        from,
                        to,
                        kind: "link",
                    },
                );
            }
        }
    }

    for tag in &tags {
        nodes.push(ApiNode {
            id: tag_id(tag),
            label: format!("#{tag}"),
            path: None,
            abs_path: None,
            group: "tag",
            word_count: None,
            modified: None,
        });
    }

    let edges: Vec<ApiEdge> = edge_map.into_values().collect();
    let note_links = edges.iter().filter(|edge| edge.kind == "link").count();
    let tag_links = edges.iter().filter(|edge| edge.kind == "tag").count();

    ApiGraph {
        notebook: notebook.display().to_string(),
        generated_at: now_isoish(),
        stats: ApiStats {
            notes: notes.len(),
            tags: tags.len(),
            edges: edges.len(),
            note_links,
            tag_links,
        },
        nodes,
        edges,
    }
}

fn resolve_target(
    raw_target: &str,
    notes: &[Note],
    by_exact: &HashMap<String, String>,
    by_stem: &HashMap<String, String>,
) -> Option<String> {
    let target = clean_target(raw_target);
    if ignored_target(&target) {
        return None;
    }
    let stem = strip_md(&target);
    if let Some(path) = by_exact.get(&target) {
        return Some(path.clone());
    }
    if let Some(path) = by_stem.get(&stem) {
        return Some(path.clone());
    }
    let markdown_target = format!("markdown/{target}");
    if let Some(path) = by_exact.get(&markdown_target) {
        return Some(path.clone());
    }
    for note in notes {
        if note.path.ends_with(&format!("/{target}"))
            || strip_md(&note.path).ends_with(&format!("/{stem}"))
            || note.filename_stem == stem
        {
            return Some(note.path.clone());
        }
    }
    None
}

fn clean_target(raw: &str) -> String {
    let mut target = raw.trim().to_string();
    if target.starts_with('<') && target.ends_with('>') {
        target = target[1..target.len() - 1].to_string();
    }
    target = target
        .split('#')
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("")
        .replace("%20", " ");
    target
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_string()
}

fn ignored_target(target: &str) -> bool {
    static IGNORED_RE: OnceLock<Regex> = OnceLock::new();
    let re = IGNORED_RE.get_or_init(|| {
        Regex::new(r"(?i)^(https?|mailto):|\.(png|jpe?g|gif|svg|webp|pdf)$").unwrap()
    });
    target.is_empty() || re.is_match(target)
}

fn markdown_targets(text: &str) -> Vec<String> {
    static MARKDOWN_LINK_RE: OnceLock<Regex> = OnceLock::new();
    let re =
        MARKDOWN_LINK_RE.get_or_init(|| Regex::new(r"!?\[[^\]\n]+\]\((<[^>]+>|[^)]+)\)").unwrap());
    re.captures_iter(text)
        .filter(|captures| !captures.get(0).map_or("", |m| m.as_str()).starts_with("!["))
        .filter_map(|captures| captures.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

fn strip_md(value: &str) -> String {
    value
        .strip_suffix(".md")
        .or_else(|| value.strip_suffix(".MD"))
        .unwrap_or(value)
        .to_string()
}

fn title_of(note: &Note) -> String {
    let title = note.title.trim();
    if title.is_empty() {
        note.filename_stem.clone()
    } else {
        title.to_string()
    }
}

fn note_id(path: &str) -> String {
    format!("note:{path}")
}

fn tag_id(tag: &str) -> String {
    format!("tag:{tag}")
}

fn now_isoish() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("{seconds}")
}
