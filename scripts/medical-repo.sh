#!/usr/bin/env bash
#
# git / gh for the medical group's ingest PRs, and nothing else.
#
#   medical-repo.sh git <args...>   git in /workspace/extra/repo
#   medical-repo.sh gh  <args...>   gh against dsaltz432/daniel-medical-history
#
# The token is a fine-grained PAT scoped to daniel-medical-history only
# (contents + pull requests), read from the group's own .claude — never an env
# var, so noSecretEnv stays meaningful. The checkout's SSH remote is rewritten
# to HTTPS per invocation (-c), so the host checkout's config is untouched.
# Commits are authored "NanoClaw medical ingest <dsaltzai@gmail.com>", which is
# how scripts/medical-github.py recognises the agent's commits on main.
#
# Guard rails (the repo is on GitHub Free: no branch protection, so these and
# the post-run audit in medical-github.py are the enforcement):
#   - push: only to refs named ingest/*; never main/master; no --force
#     (--force-with-lease on an ingest/* branch is allowed, for rebases)
#   - gh: no `pr merge`, no `repo`, no `api` (use medical-github.py for reads)

set -euo pipefail

REPO_DIR="${MEDICAL_REPO_DIR:-/workspace/extra/repo}"
SLUG="dsaltz432/daniel-medical-history"
TOKEN_FILE="${MEDICAL_GITHUB_TOKEN_FILE:-/home/node/.claude/github-token}"

die() { echo "medical-repo.sh: $*" >&2; exit 2; }

[ -s "$TOKEN_FILE" ] || die "no GitHub token at $TOKEN_FILE (see groups/medical/CLAUDE.md)"
GH_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
export GH_TOKEN
# The container runs as the host uid, which can't write /home/node/.config.
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-/tmp/gh-config}" GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1

tool="${1:-}"; shift || true
case "$tool" in
  git)
    if [ "${1:-}" = "push" ]; then
      refs=0
      for a in "${@:2}"; do
        case "$a" in
          --force|-f|--mirror|--all|--delete|-d) die "refusing push flag '$a'" ;;
          --force-with-lease*|--set-upstream|-u|-q|--quiet|origin) ;;
          -*) die "refusing unexpected push flag '$a'" ;;
          *)
            ref="${a#+}"; ref="${ref##*:}"; ref="${ref#refs/heads/}"
            case "$ref" in
              ingest/*) refs=$((refs + 1)) ;;
              *) die "refusing to push '$a' — only ingest/* branches" ;;
            esac
            ;;
        esac
      done
      [ "$refs" -gt 0 ] || die "name the ingest/* branch explicitly: git push -u origin ingest/<date>"
    fi
    exec git -C "$REPO_DIR" \
      -c url."https://github.com/".insteadOf="git@github.com:" \
      -c credential.helper= \
      -c credential.helper='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' \
      -c user.name="NanoClaw medical ingest" \
      -c user.email="dsaltzai@gmail.com" \
      "$@"
    ;;
  gh)
    case "${1:-} ${2:-}" in
      "pr merge"*|"repo "*|"api "*|"secret "*|"auth "*) die "refusing 'gh $1 ${2:-}'" ;;
    esac
    cd "$REPO_DIR"
    exec gh "$@" --repo "$SLUG"
    ;;
  *)
    die "usage: medical-repo.sh git|gh <args...>"
    ;;
esac
