#!/bin/zsh
# Daily full backup of the BodyData production database to this Mac.
# Keeps 30 days (the Privacy Policy promises backups are gone within 90).
# Installed as a LaunchAgent: ~/Library/LaunchAgents/ai.bodydata.backup.plist
set -u
DIR="$HOME/Biotracker/backups"
API="https://biotrack-api-production.up.railway.app"
mkdir -p "$DIR" && chmod 700 "$DIR"
umask 077
OUT="$DIR/bodydata-$(date +%Y%m%d-%H%M).ndjson.gz"
TMP="$OUT.part"
if curl -sf -m 1800 "$API/admin/backup" -H "x-api-secret: $(cat "$HOME/.biotrack_secret")" -o "$TMP" \
   && gzip -dc "$TMP" | tail -1 | grep -q '"end":true'; then
  mv "$TMP" "$OUT"
  echo "$(date '+%F %T') ok $(du -h "$OUT" | cut -f1) $OUT"
else
  [ -f "$TMP" ] && unlink "$TMP"
  echo "$(date '+%F %T') FAILED"
  osascript -e 'display notification "The database backup failed. See ~/Biotracker/backups/backup.log" with title "BodyData backup failed"' 2>/dev/null
  exit 1
fi
# 30-day retention for every backup file in the folder (including older one-off exports)
find "$DIR" -maxdepth 1 -type f \( -name '*.ndjson.gz' -o -name '*.json' \) -mtime +30 -print -delete
