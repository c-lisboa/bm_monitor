from datetime import datetime, timedelta, timezone
import logging
import os
from pathlib import Path
import re
import tempfile
import threading
import time

from flask import Flask, jsonify, render_template, request
import ijson
import requests

app = Flask(__name__)

BM_SERVER_URL = "https://bm.dvbrazil.com.br/status/extra/heard.php"
RADIOID_USERS_URL = "https://database.radioid.net/static/users.json"
RADIOID_CACHE_PATH = Path(app.instance_path) / "users.json"
RADIOID_REFRESH_INTERVAL_SECONDS = 24 * 60 * 60
RADIOID_DOWNLOAD_TIMEOUT = (15, 180)
BRASILIA_TZ = timezone(timedelta(hours=-3))
DMR_COUNTRY_PREFIXES = {
    "724": "Brasil",
}

_radioid_lock = threading.Lock()
_radioid_index = {}


def _text(value):
    """Converte valores cadastrais em texto sem produzir 'None' na tela."""
    if value is None:
        return ""
    return str(value).strip()


def _radioid_record_id(record):
    value = record.get("radio_id")
    if value is None or value == "":
        value = record.get("id")
    return _text(value)


def load_radioid_index(json_path):
    """
    Lê users.item de forma incremental para evitar carregar o JSON inteiro
    de 80 MB em memória.
    """
    index = {}

    with open(json_path, "rb") as json_file:
        for record in ijson.items(json_file, "users.item"):
            if not isinstance(record, dict):
                continue

            radio_id = _radioid_record_id(record)
            if not radio_id:
                continue

            index[radio_id] = {
                "surname": _text(record.get("surname")),
                "city": _text(record.get("city")),
                "state": _text(record.get("state")),
                "country": _text(record.get("country")),
            }

    if not index:
        raise ValueError("O arquivo RadioID não contém cadastros utilizáveis.")

    return index


def load_cached_radioid():
    """Carrega a última base válida disponível no disco, se existir."""
    global _radioid_index

    if not RADIOID_CACHE_PATH.is_file():
        return

    try:
        index = load_radioid_index(RADIOID_CACHE_PATH)
    except Exception:
        app.logger.exception("Não foi possível ler a cópia local de users.json.")
        return

    with _radioid_lock:
        _radioid_index = index

    app.logger.info("Base RadioID local carregada: %s cadastros.", len(index))


def refresh_radioid_database():
    """
    Baixa, valida e instala a base nova. A cópia anterior só é substituída
    depois que o arquivo recebido foi lido com sucesso.
    """
    global _radioid_index

    RADIOID_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None

    try:
        with requests.get(
            RADIOID_USERS_URL,
            stream=True,
            timeout=RADIOID_DOWNLOAD_TIMEOUT,
        ) as response:
            response.raise_for_status()

            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix="users-",
                suffix=".json.tmp",
                dir=RADIOID_CACHE_PATH.parent,
                delete=False,
            ) as temporary_file:
                temporary_path = Path(temporary_file.name)

                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        temporary_file.write(chunk)

                temporary_file.flush()
                os.fsync(temporary_file.fileno())

        new_index = load_radioid_index(temporary_path)

        # A troca atômica mantém a última cópia válida se o download ou
        # a validação da nova base falhar.
        os.replace(temporary_path, RADIOID_CACHE_PATH)
        temporary_path = None

        with _radioid_lock:
            _radioid_index = new_index

        app.logger.info(
            "Base RadioID atualizada: %s cadastros.",
            len(new_index),
        )
        return True

    except Exception:
        app.logger.exception(
            "Falha ao atualizar a base RadioID; será mantida a última cópia válida."
        )
        return False

    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                app.logger.warning("Não foi possível remover o arquivo temporário.")


def _radioid_refresh_worker():
    """Tenta atualizar a base ao iniciar e, depois, uma vez por dia."""
    while True:
        refresh_radioid_database()
        time.sleep(RADIOID_REFRESH_INTERVAL_SECONDS)


def start_radioid_refresh_thread():
    # Evita iniciar duas threads no reloader de desenvolvimento do Flask.
    if app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return

    thread = threading.Thread(
        target=_radioid_refresh_worker,
        name="radioid-database-refresh",
        daemon=True,
    )
    thread.start()


def enrich_from_radioid(entry):
    """Complementa sobrenome, cidade/estado e país pelo DMR ID."""
    dmrid = _text(entry.get("dmrid"))
    if not dmrid:
        return entry

    with _radioid_lock:
        registration = _radioid_index.get(dmrid)

    if registration:
        surname = registration.get("surname", "")
        if surname:
            entry["surname"] = surname

        city = registration.get("city", "")
        state = registration.get("state", "")

        if city and state and city.casefold() != state.casefold():
            entry["city_state"] = f"{city}, {state}"
        elif city or state:
            entry["city_state"] = city or state

        country = registration.get("country", "")
        if country:
            entry["country"] = country
            return entry

    # Se a base não tiver o país cadastral, usa um prefixo conhecido.
    # Prefixos não reconhecidos ficam sem país, evitando inferências.
    entry["country"] = DMR_COUNTRY_PREFIXES.get(dmrid[:3], "")
    return entry


def fetch_heard_data(server_url):
    """Busca os dados do BrandMeister e valida o formato da resposta."""
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
    if info_raw and callsign and str(callsign) not in str(info_raw):
        country = info_raw
    elif info_raw and not callsign:
        country = info_raw

    dmrid = entry[9] if entry[9] else ""
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
    # Sem tg, retorna registros de todas as TGs para uma única consulta
    # periódica no navegador.
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
        return jsonify(
            {"error": "Não foi possível consultar o BrandMeister."}
        ), 502
    except Exception:
        app.logger.exception("Erro inesperado ao consultar o BrandMeister.")
        return jsonify(
            {"error": "Erro inesperado ao consultar o BrandMeister."}
        ), 500

    results = []

    for raw_entry in data:
        try:
            parsed = parse_heard_entry(raw_entry, tg)
        except (IndexError, TypeError, ValueError):
            app.logger.warning("Registro inválido recebido do BrandMeister.")
            continue

        if parsed and parsed["raw_timestamp"] >= since:
            results.append(enrich_from_radioid(parsed))

    results.sort(key=lambda item: item["raw_timestamp"], reverse=True)
    return jsonify({"entries": results, "tg": tg})


# Carrega a cópia local imediatamente, se já houver uma; o download inicial
# acontece em segundo plano para não bloquear a inicialização do servidor.
load_cached_radioid()
start_radioid_refresh_thread()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    app.run(debug=True, host="0.0.0.0", port=5000)
