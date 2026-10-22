#!/usr/bin/env bash
# Atualiza todas as instalações a partir do repositório principal (branch main).
# Lê /etc/escritorio-agentes/instances.conf; só reinicia quem mudou.
# Uso: sudo escritorio-update [--force]
set -euo pipefail
CONF=${CONF:-/etc/escritorio-agentes/instances.conf}
BRANCH=${BRANCH:-main}
FORCE=${1:-}
log() { echo "[$(date '+%F %T')] $*"; }
[ -f "$CONF" ] || { log "sem $CONF"; exit 1; }
grep -vE '^\s*(#|$)' "$CONF" | while read -r nome dir servico; do
  owner=$(stat -c %U "$dir")
  g() { sudo -u "$owner" git -C "$dir" "$@"; }
  g fetch --quiet origin "$BRANCH" || { log "$nome: falha no fetch"; continue; }
  local_rev=$(g rev-parse HEAD); remote_rev=$(g rev-parse "origin/$BRANCH")
  if [ "$local_rev" = "$remote_rev" ] && [ "$FORCE" != "--force" ]; then continue; fi
  if ! g merge --ff-only --quiet "origin/$BRANCH"; then
    log "$nome: alterações locais impedem o update (nada mudou)"; continue
  fi
  systemctl restart "$servico"
  sleep 3
  if systemctl is-active --quiet "$servico"; then
    log "$nome: atualizado ${local_rev:0:7} -> ${remote_rev:0:7}"
  else
    log "$nome: FALHOU ao subir; voltando para ${local_rev:0:7}"
    g reset --hard --quiet "$local_rev"
    systemctl restart "$servico"
  fi
done
