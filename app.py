from datetime import datetime, timedelta, timezone
import logging
import re

from flask import Flask, jsonify, render_template, request
import requests

app = Flask(__name__)

BM_SERVER_URL = "https://bm.dvbrazil.com.br/status/extra/heard.php"
BRASILIA_TZ = timezone(timedelta(hours=-3))


def fetch_heard_data(server_url):
    """Busca os dados e confirma que a resposta tem o formato esperado."""
    response = requests.get(server_url, timeout=10)
    response.raise_for_status()

    data = response.json()
    if not isinstance(data, list):
        raise ValueError("A resposta do servidor não é uma lista JSON.")

    return data


def parse_heard_entry(entry, target_tg=None):
    if not isinstance(entry, (list, tuple)) or len(entry) < 26:
        return None

    tg = str(entry[10]) if entry[10] else str(entry[0])

    if target_tg is not None and tg != target_tg:
        return None

    # Formato padrão:
    # [21]=indicativo, [22]=nome, [23]=sobrenome,
    # [24]=cidade/estado, [25]=país ou informação.
    #
    # Formato Layer4/DMR+:
    # [23]=indicativo, [24]=nome, [25]=None.
    callsign = entry[21] or (entry[23] if len(entry) > 23 else "")
    name = entry[22] or (entry[24] if len(entry) > 24 else "")
    surname = entry[23] if entry[23] and entry[21] else ""
    city_state = entry[24] if entry[24] and entry[22] else ""

    info_raw = entry[25] if len(entry) > 25 and entry[25] else ""
    full_name = entry[26] if len(entry) > 26 and entry[26] else ""

    country = ""
    if info_raw and callsign and callsign not in str(info_raw):
        country = info_raw
    elif info_raw and not callsign:
        country = info_raw

    dmrid = entry[9] or ""
    timestamp_value = entry[3] or entry[2]
    mode = entry[4] or ""

    try:
        timestamp = int(float(timestamp_value))
        dt = datetime.fromtimestamp(timestamp, tz=BRASILIA_TZ)
    except (TypeError, ValueError, OverflowError, OSError):
        return None

    return {
        "tg": tg,
        "callsign": callsign,
        "name": name,
        "surname": surname,
        "city_state": city_state,
        "country": country,
        "full_name": full_name,
        "dmrid": dmrid,
        "timestamp": dt.strftime("%d/%m/%Y %H:%M:%S"),
        "mode": mode,
        "raw_timestamp": timestamp,
    }


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/heard")
def api_heard():
    # O parâmetro tg é opcional. Sem ele, a resposta inclui todas as TGs
    # para que o navegador possa distribuí-las após uma única consulta.
    tg = request.args.get("tg")
    if tg is not None:
        tg = tg.strip()
        if not re.fullmatch(r"\d{1,20}", tg):
            return jsonify({"error": "A TG deve conter somente números."}), 400

    try:
        since = int(request.args.get("since", "0"))
    except (TypeError, ValueError):
        since = 0

    since = max(since, 0)

    try:
        data = fetch_heard_data(BM_SERVER_URL)
    except (requests.RequestException, ValueError) as error:
        app.logger.error("Erro ao consultar o BrandMeister: %s", error)
        return jsonify({"error": "Não foi possível consultar o BrandMeister."}), 502
    except Exception:
        app.logger.exception("Erro inesperado ao consultar o BrandMeister.")
        return jsonify({"error": "Erro inesperado ao consultar o BrandMeister."}), 500

    results = []

    for entry in data:
        try:
            parsed = parse_heard_entry(entry, tg)
        except (IndexError, TypeError, ValueError):
            app.logger.warning("Registro inválido recebido do BrandMeister.")
            continue

        if parsed and parsed["raw_timestamp"] >= since:
            results.append(parsed)

    results.sort(key=lambda item: item["raw_timestamp"], reverse=True)
    return jsonify({"entries": results, "tg": tg})


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
