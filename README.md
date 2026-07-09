I'VE NOT READ A LOC OF THIS. 

On the other hand, I'd not have had the time to write this otherwise, and I needed this kind of tool.

Make of this what you will.

# Rust Prototype

Single-binary prototype for `roam-graph-html`.

It embeds a snapshot of the frontend assets from `public/` and serves:

```text
http://127.0.0.1:4174
```

It does not bundle or replace `zk`. It can either call an external `zk`
binary from `PATH`, or consume `zk graph --format json` output from stdin or
a file.

## Run

Enter the flake dev shell:

```sh
nix develop
```

Default mode calls external `zk` for each graph reload:

```sh
cargo run
```

Stdin mode consumes precomputed `zk` JSON once at startup:

```sh
zk graph --format json --quiet | cargo run -- --stdin
```

File mode serves precomputed `zk` JSON and does not call `zk`:

```sh
zk graph --format json --quiet > graph.json
cargo run -- --graph-json graph.json
```

## Build A Binary

```sh
cargo build --release
```

The binary will be:

```text
target/release/roam-graph-html
```

Runtime requirements:

- default mode: `zk` available on `PATH`, and an initialized zk notebook
- stdin or file mode: JSON produced by `zk graph --format json`

Default notebook:

```text
~/Documents/Nextcloud/Notes
```

Override:

```sh
NOTEBOOK=/path/to/notebook ./target/release/roam-graph-html
./target/release/roam-graph-html --notebook /path/to/notebook
```

Run with stdin:

```sh
zk graph --format json --quiet | ./target/release/roam-graph-html --stdin
```

Override port:

```sh
PORT=8080 ./target/release/roam-graph-html
./target/release/roam-graph-html --port 8080
```
