#!/bin/bash
# Read JSON data that Claude Code sends to stdin and format the status line
python3 -c '
import json, sys

data = json.load(sys.stdin)
model = data.get("model", {}).get("display_name", "")
current_dir = data.get("workspace", {}).get("current_dir", "")
ctx = data.get("context_window", {})
pct = int(ctx.get("used_percentage") or 0)
tokens = int(ctx.get("total_input_tokens") or 0) + int(ctx.get("total_output_tokens") or 0)
folder = current_dir.rstrip("/").rsplit("/", 1)[-1]

print(f"[{model}] \U0001F4C1 {folder} | {pct}% context | {tokens:,} tokens")
'
