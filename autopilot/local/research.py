"""Research helper: crawl an HMRC/gov.uk page via the bridge (Crawl4AI) for rule verification. Read-only."""
import sys, httpx, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent)); from common import E
url = sys.argv[1] if len(sys.argv) > 1 else "https://www.gov.uk/vat-rates"
r = httpx.post("http://127.0.0.1:8765/crawl", json={"url": url}, headers={"Authorization": "Bearer " + E("BRIDGE_TOKEN")}, timeout=180)
print(r.status_code, r.text[:1500])
