#!/bin/sh
set -e
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
Xvnc :1 -geometry 1280x800 -depth 24 -SecurityTypes None -rfbport 5900 -AlwaysShared &
sleep 1
export DISPLAY=:1
openbox &
sleep 0.5
xterm -geometry 100x28+20+20 -fa Monospace -fs 11 &
cd /opt/noVNC
exec bash /opt/noVNC/utils/novnc_proxy --vnc localhost:5900 --listen 6081
