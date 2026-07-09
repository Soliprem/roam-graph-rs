# Rust Prototype

Single-binary prototype for `roam-graph-html`.

It embeds a snapshot of the frontend assets from `public/` and serves:

```text
http://127.0.0.1:4174
```

It does not bundle or replace `zk`. It can either call an external `zk`
binary from `PATH`, or consume `zk graph --format json` output from stdin.

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
- stdin mode: JSON produced by `zk graph --format json`

Default notebook:

```text
~/Documents/Nextcloud/Notes
```

Override:

```sh
NOTEBOOK=/path/to/notebook ./target/release/roam-graph-html
```

Run with stdin:

```sh
zk graph --format json --quiet | ./target/release/roam-graph-html --stdin
```

Override port:

```sh
PORT=8080 ./target/release/roam-graph-html
```
