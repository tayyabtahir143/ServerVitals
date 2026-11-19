import os
import sys
import time
from pathlib import Path

script = sys.stdin.read()
if "a.invalid" in sys.argv and "df -kP '/srv/data'" not in script and "df -kP '/data set'" not in script:
    sys.exit(3)
unplug = Path(os.environ["T"]) / "unplug"
tick = 1
drops = 0
while True:
    bad = "a.invalid" in sys.argv and (unplug.parent / 'pressure').exists()
    if "a.invalid" in sys.argv and (unplug.parent / 'offline').exists():
        sys.exit(1)
    drops += int(bad)
    interfaces = "eth0 101 202" if unplug.exists() else "eth0 101 202 wg0 303 404"
    interfaces += " " + " ".join(f"veth{n:03d} {n} {n}" for n in range(128))
    interfaces += " eno2 505 606"
    if tick % 2:
        interfaces += " ephemeral 0 0"
    default = "eth0" if "a.invalid" in sys.argv else ("eno2" if (unplug.parent / "route-b").exists() else "-")
    parts = interfaces.split()
    interfaces = ' '.join(f'{n} {rx} {tx} {drops} 0' for n, rx, tx in zip(parts[::3], parts[1::3], parts[2::3]))
    free = 5 if bad else max(110, 900 - tick)
    if "a.invalid" in sys.argv:
        print("SVT 45000 coretemp Package id 0")
        print("SVT 61500 nvme Composite")
        print("SVG 37, 1024, 8192, 60, 30, 55.20, Test GPU 9000")
    print(f"SV6 {default} {tick*60} 1 2 3 2000 1000 {2*tick} {tick} 1 1000 {1000-free} {free} 600 300 2000 500 2 / 9000 3000 6000 /data 5000 2000 3000 {interfaces}", flush=True)
    time.sleep(0.25)
    tick += 1
