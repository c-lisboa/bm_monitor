from flask import Flask, render_template, request, jsonify
import requests
import time
from datetime import datetime
from functools import lru_cache

app = Flask(__name__)

BM_SERVERS = {
    "bm.dvbrazil.com.br": "https://bm.dvbrazil.com.br/status/extra/heard.php",
    "bm2222.network": "https://bm2222.network/status/extra/heard.php",
    "bm2221.network": "https://bm2221.network/status/extra/heard.php",
    "master.brandmeister.network": "https://master.brandmeister.network/status/extra/heard.php",
}

DEFAULT_SERVER = "bm.dvbrazil.com.br"
DEFAULT_TG = "724"


def fetch_heard_data(server_url):
    try:
        resp = requests.get(server_url, timeout=10)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        app.logger.error(f"Erro ao buscar dados de {server_url}: {e}")
        return []


def parse_heard_entry(entry, target_tg):
    if len(entry) < 26:
        return None
    
    tg = str(entry[10]) if entry[10] else str(entry[0])
    target_str = str(target_tg)
    if tg != target_str:
        return None
    
    # Handle different data layouts
    # Standard layout: [21]=callsign, [22]=name, [23]=surname, [24]=city_state, [25]=country/info
    # Layer4/DMR+ layout: [23]=callsign, [24]=name, [25]=None
    callsign = entry[21] if entry[21] else (entry[23] if len(entry) > 23 and entry[23] else "")
    name = entry[22] if entry[22] else (entry[24] if len(entry) > 24 and entry[24] else "")
    surname = entry[23] if entry[23] and entry[21] else ""
    city_state = entry[24] if entry[24] and entry[22] else ""
    
    # entry[25] is often full_name (contains callsign) or country info
    info_raw = entry[25] if len(entry) > 25 and entry[25] else ""
    full_name = entry[26] if len(entry) > 26 and entry[26] else ""
    
    # If info_raw contains callsign, it's likely full_name, not country
    country = ""
    if info_raw and callsign and callsign not in info_raw:
        country = info_raw
    elif info_raw and not callsign:
        country = info_raw
    
    dmrid = entry[9] if entry[9] else ""
    timestamp = entry[3] if entry[3] else entry[2]
    mode = entry[4] if entry[4] else ""
    
    dt = datetime.fromtimestamp(timestamp) if timestamp else datetime.now()
    
    return {
        "callsign": callsign,
        "name": name,
        "surname": surname,
        "city_state": city_state,
        "country": country,
        "full_name": full_name,
        "dmrid": dmrid,
        "timestamp": dt.strftime("%d/%m/%Y %H:%M:%S"),
        "mode": mode,
        "raw_timestamp": timestamp
    }


@app.route("/")
def index():
    return render_template("index.html", servers=BM_SERVERS, default_server=DEFAULT_SERVER, default_tg=DEFAULT_TG)


@app.route("/api/heard")
def api_heard():
    server = request.args.get("server", DEFAULT_SERVER)
    tg = request.args.get("tg", DEFAULT_TG)
    since = request.args.get("since", 0, type=int)
    
    server_url = BM_SERVERS.get(server, BM_SERVERS[DEFAULT_SERVER])
    data = fetch_heard_data(server_url)
    
    results = []
    for entry in data:
        parsed = parse_heard_entry(entry, tg)
        if parsed and parsed["raw_timestamp"] > since:
            results.append(parsed)
    
    results.sort(key=lambda x: x["raw_timestamp"], reverse=True)
    return jsonify({"entries": results, "server": server, "tg": tg})


@app.route("/api/servers")
def api_servers():
    return jsonify({"servers": list(BM_SERVERS.keys()), "current": DEFAULT_SERVER})


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)