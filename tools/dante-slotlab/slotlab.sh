#!/bin/sh
# dante-slotlab: lets Warm-Up try cluster-render's `panel` target in another KOMBI slot, from the car.
#
# An app cannot change cluster-render's settings: they are root's, and take a restart of the service.
# This does that one job and nothing else. It only ever touches its own block in
# cluster-render.local.conf, and takes one request at a time from a file in
# /dev/shm/dante-slotlab/in/, each word of it checked against what is allowed, never run.
#
#   try <slot> <scene> <class> <seconds>   move panel there for that long, then back by itself
#   keep                                   make the trial stay, across restarts
#   revert                                 end the trial
#   stock                                  back to cluster-render's own settings
#   scan                                   publish the slot lines of cluster-render's log
#
# It writes state and slots.txt in /dev/shm/dante-slotlab for the app to read. slotlab.sh --restore
# (the tool's removal) takes its block out again. See apps/warmup/CLUSTER.md.
set -f
umask 022

ROOT=${SLOTLAB_ROOT:-}              # the tests run it in a sandbox
LAB=$ROOT/dev/shm/dante-slotlab
IN=$LAB/in
RENDER=$ROOT/var/opt/cluster-render
CONF=$RENDER/cluster-render.local.conf
LOG=$RENDER/log/cluster-render.log
KEPT=$RENDER/dante-slotlab.kept     # the kept slot, for coming back to after a trial
TICK=${SLOTLAB_TICK:-1}
BEGIN='# dante-slotlab begin'
END='# dante-slotlab end'

mode=stock; slot=; scene=; class=; deadline=0; msg=

restart_render() {
    if [ -n "$SLOTLAB_RESTART" ]; then $SLOTLAB_RESTART; else systemctl restart cluster-render.service; fi
}

# the conf without our block
others() {
    if [ -f "$CONF" ]; then sed "/^$BEGIN/,/^$END/d" "$CONF"; fi
    return 0
}

# write_conf [kind slot scene class]: our block replaced, or gone with no arguments.
# A kept slot takes over from the stock HMI: the KOMBI never takes a slot from the content it shows,
# so once the icon has hidden and the stock content (an M badge, say) is back in the slot, the icon
# could never show there again until a restart. With take-over, cluster-render moves the stock
# content aside for a layer that contends (Warm-Up's icon does), and the KOMBI puts it back when the
# icon goes. A trial does not: it is there to see what shares the slot, not to push anything out.
write_conf() {
    tmp=$CONF.lab
    others > "$tmp" || return 1
    if [ -n "$1" ]; then
        {
            echo "$BEGIN $1"
            echo "panel_slot = $2"
            echo "panel_scene_id = $3"
            echo "panel_content_class = $4"
            if [ "$1" = kept ]; then echo "panel_take_over_stock = 1"; fi
            echo "$END"
        } >> "$tmp" || return 1
    fi
    if [ -s "$tmp" ]; then
        chmod 0644 "$tmp" && mv -f "$tmp" "$CONF"
    else
        rm -f "$tmp" "$CONF"
    fi
}

load_kept() {
    kslot=; kscene=; kclass=
    if [ -f "$KEPT" ]; then read -r kslot kscene kclass < "$KEPT" || true; fi
}

# back to what was there before any trial: the kept slot, else stock
fall_back() {
    load_kept
    if [ -n "$kslot" ]; then
        write_conf kept "$kslot" "$kscene" "$kclass"
        mode=kept; slot=$kslot; scene=$kscene; class=$kclass
    else
        write_conf
        mode=stock; slot=; scene=; class=
    fi
    deadline=0
    restart_render
}

bad() { msg="refused: $1"; }

request_try() {
    case "$1" in 0x[0-9a-f][0-9a-f][0-9a-f]) ;; *) bad slot; return ;; esac
    case "$2" in 0x01000400|0x010004f0|0x010004f1) ;; *) bad scene; return ;; esac
    case "$3" in 0|512|1024) ;; *) bad class; return ;; esac
    case "$4" in [1-9][0-9]|[1-9][0-9][0-9]) ;; *) bad seconds; return ;; esac
    if [ ! -d "$RENDER/current" ] && [ -z "$SLOTLAB_ROOT" ]; then msg='cluster-render is not installed'; return; fi
    secs=$4
    if [ "$secs" -gt 300 ]; then secs=300; fi
    deadline=$(( $(date +%s) + secs ))
    msg=
    # asked again for the same thing: only the time runs on
    if [ "$mode" = trial ] && [ "$slot" = "$1" ] && [ "$scene" = "$2" ] && [ "$class" = "$3" ]; then return; fi
    if write_conf trial "$1" "$2" "$3"; then
        mode=trial; slot=$1; scene=$2; class=$3
        restart_render
    else
        msg='could not write the settings'
    fi
}

publish_slots() {
    {
        if [ -f "$LOG.1" ]; then grep -h 'dcsm: slot' "$LOG.1"; fi
        if [ -f "$LOG" ]; then grep -h 'dcsm: slot' "$LOG"; fi
    } 2>/dev/null | tail -n 800 > "$LAB/slots.tmp"
    mv -f "$LAB/slots.tmp" "$LAB/slots.txt"
}

handle() {
    [ -f "$IN/request" ] && [ ! -L "$IN/request" ] || return 0
    line=$(head -c 100 "$IN/request" | head -n 1)
    rm -f "$IN/request"
    set -- $line
    case "$1" in
        try) request_try "$2" "$3" "$4" "$5" ;;
        keep)
            if [ "$mode" = trial ]; then
                echo "$slot $scene $class" > "$KEPT"
                write_conf kept "$slot" "$scene" "$class"
                mode=kept; deadline=0; msg=
                restart_render              # the kept block adds take-over, which the trial ran without
            fi
            ;;
        revert) if [ "$mode" = trial ]; then fall_back; msg=; fi ;;
        stock)
            rm -f "$KEPT"
            if [ "$mode" != stock ]; then fall_back; msg=; fi
            ;;
        scan) publish_slots ;;
        *) bad request ;;
    esac
}

publish() {
    left=0
    if [ "$deadline" -gt 0 ]; then left=$(( deadline - $(date +%s) )); fi
    {
        echo "mode=$mode"
        echo "slot=$slot"
        echo "scene=$scene"
        echo "class=$class"
        echo "left=$left"
        echo "msg=$msg"
    } > "$LAB/state.tmp"
    mv -f "$LAB/state.tmp" "$LAB/state"
}

if [ "$1" = --restore ]; then
    had=0
    if [ -f "$CONF" ] && grep -q "^$BEGIN" "$CONF"; then had=1; fi
    rm -f "$KEPT"
    write_conf
    if [ "$had" = 1 ]; then restart_render; fi
    exit 0
fi

# where the app can read (this folder, root's) and write (in/, nothing else)
mkdir -p "$IN"
chmod 0755 "$LAB"
if chgrp tm_oap_app "$IN" 2>/dev/null; then chmod 2775 "$IN"; else chmod 0777 "$IN"; fi
rm -f "$IN/request"

# a trial never outlives the head unit: only a kept slot comes back after a restart
load_kept
if [ -f "$CONF" ] && grep -q "^$BEGIN trial" "$CONF"; then
    fall_back
elif [ -n "$kslot" ]; then
    mode=kept; slot=$kslot; scene=$kscene; class=$kclass
    # a slot kept by 1.0.0 has no take-over: write it as this version does, once
    if [ -f "$CONF" ] && ! sed -n "/^$BEGIN kept/,/^$END/p" "$CONF" | grep -q '^panel_take_over_stock = 1'; then
        write_conf kept "$kslot" "$kscene" "$kclass" && restart_render
    fi
fi

trap 'exit 0' TERM INT
while :; do
    handle
    if [ "$mode" = trial ] && [ "$(date +%s)" -ge "$deadline" ]; then
        fall_back
        msg='trial ran out'
    fi
    publish
    sleep "$TICK"
done
