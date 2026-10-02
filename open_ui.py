import sys
import time
import urllib.request
import webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
URL = f"http://127.0.0.1:{PORT}/"

for _ in range(120):                       # wait up to 60 s for the server
    try:
        urllib.request.urlopen(URL + "api/config", timeout=1)
        break
    except Exception:
        time.sleep(0.5)
else:
    print("server did not come up on port", PORT, file=sys.stderr)
    raise SystemExit(1)

print("opening", URL)
webbrowser.open(URL)
