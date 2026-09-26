#!/usr/bin/env sh
# jobpilot — fallback installer for CLIs without a plugin system (Cursor CLI,
# or any agent that reads plain skill folders).
#
# What it does:
#   1. Symlinks skills/<name>/ into each CLI's personal skills directory.
#   2. Records the plugin root in ~/.jobpilot.json so every SKILL.md can run
#      scripts via the same absolute path on any CLI.
#
# Claude Code and Codex should install via their plugin commands instead:
#   Claude Code: /plugin marketplace add Krutarth22/jobpilot && /plugin install jobpilot@jobpilot
#   Codex:       codex plugin marketplace add Krutarth22/jobpilot && codex plugin add jobpilot@jobpilot
set -eu

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

link_skills() {
  dest_dir="$1"
  mkdir -p "$dest_dir"
  for skill_dir in "$REPO_DIR"/skills/*/; do
    name="$(basename "$skill_dir")"
    dest="$dest_dir/$name"
    # Replace a previous symlink or stale copy; never touch other skills.
    if [ -L "$dest" ]; then
      rm "$dest"
    elif [ -d "$dest" ]; then
      echo "  ! $dest already exists and is a directory — leaving it alone"
      continue
    fi
    ln -s "$skill_dir" "$dest"
    echo "  + $dest -> $skill_dir"
  done
}

echo "jobpilot: linking skills"
if [ -d "$HOME/.cursor/skills" ] || [ "${1#--}" = "cursor" ] || [ -d "$HOME/.cursor" ]; then
  link_skills "$HOME/.cursor/skills"
fi
if [ -d "$HOME/.codex" ]; then
  link_skills "$HOME/.codex/skills"
fi
if [ -d "$HOME/.agents" ]; then
  link_skills "$HOME/.agents/skills"
fi

# Record the plugin root so skills resolve scripts identically everywhere.
node - "$REPO_DIR" <<'EOF'
const fs = require('fs');
const path = require('path');
const os = require('os');
const repo = process.argv[2];
const cfgPath = path.join(os.homedir(), '.jobpilot.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
cfg.pluginRoot = repo;
if (!cfg.root) cfg.root = path.join(os.homedir(), 'jobpilot');
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
console.log(`jobpilot: wrote ${cfgPath} (pluginRoot=${repo}, workspace=${cfg.root})`);
EOF

echo "jobpilot: done. Next: run the setup skill with your resume, or 'npm i' in $REPO_DIR first."
