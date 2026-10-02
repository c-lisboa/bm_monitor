from flask import Flask, render_template, request, jsonify
import requests
from datetime import datetime

app = Flask(__name__)

BM_SERVER_URL = "https://bm.dvbrazil.com.br/status/extra/heard.php"


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

    # Formato padrão: [21]=indicativo, [22]=nome, [23]=sobrenome,
    # [24]=cidade/estado, [25]=país ou informação
    # Formato Layer4/DMR+: [23]=indicativo, [24]=nome, [25]=None
    callsign = entry[21] if entry[21] else (entry[23] if len(entry) > 23 and entry[23] else "")
    name = entry[22] if entry[22] else (entry[24] if len(entry) > 24 and entry[24] else "")
    surname = entry[23] if entry[23] and entry[21] else ""
    city_state = entry[24] if entry[24] and entry[22] else ""

    info_raw = entry[25] if len(entry) > 25 and entry[25] else ""
    full_name = entry[26] if len(entry) > 26 and entry[26] else ""

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
    return render_template("index.html")


@app.route("/api/heard")
def api_heard():
    tg = request.args.get("tg", "")
    since = request.args.get("since", 0, type=int)

    data = fetch_heard_data(BM_SERVER_URL)

    results = []
    for entry in data:
        parsed = parse_heard_entry(entry, tg)
        if parsed and parsed["raw_timestamp"] > since:
            results.append(parsed)

    results.sort(key=lambda x: x["raw_timestamp"], reverse=True)
    return jsonify({"entries": results, "tg": tg})


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
