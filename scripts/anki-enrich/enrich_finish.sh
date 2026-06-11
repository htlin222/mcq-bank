#!/bin/zsh
# Pipeline: repeatedly merge final5 -> merged5 and insert into 02_Hematology_enrich,
# overlapping with the still-running selection, until all 300 are inserted.
BASE=/tmp/hema_anki; cd "$BASE" || exit 1
log(){ echo "[$(date +%H:%M:%S)] $*" >> "$BASE/enrich_finish.log"; }
log "pipeline started"
prev=-1; stable=0
for i in $(seq 1 160); do
  HEMA_FINAL_DIR=final5 HEMA_MERGED_DIR=merged5 python3 "$BASE/merge_final.py" >> "$BASE/enrich_finish.log" 2>&1
  HEMA_GEN="$BASE/merged5" HEMA_DECK_PREFIX=02_Hematology_enrich HEMA_DONE="$BASE/inserted_enrich.txt" \
    HEMA_FAIL="$BASE/failures_enrich.json" HEMA_LOG="$BASE/insert_enrich.log" python3 "$BASE/insert_all.py" >> "$BASE/enrich_finish.log" 2>&1
  f5=$(ls final5/*.json 2>/dev/null | wc -l | tr -d ' ')
  ins=$(wc -l < inserted_enrich.txt 2>/dev/null | tr -d ' '); ins=${ins:-0}
  log "loop $i: final5=$f5 inserted=$ins"
  if [ "$f5" -ge 300 ] && [ "$ins" = "$prev" ]; then stable=$((stable+1)); else stable=0; fi
  prev=$ins
  if [ "$f5" -ge 300 ] && [ "$stable" -ge 1 ]; then log "all in; done"; break; fi
  sleep 15
done
log "pipeline finished: inserted=$(wc -l < inserted_enrich.txt 2>/dev/null | tr -d ' ')"
