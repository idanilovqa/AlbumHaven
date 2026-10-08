from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile


def _comparable_path(path: Path) -> str:
    value = os.path.normpath(str(path))
    if os.name == "nt":
        if value[:8].casefold() == "\\\\?\\unc\\":
            value = "\\\\" + value[8:]
        elif value.startswith("\\\\?\\"):
            value = value[4:]
    return os.path.normcase(value)


def _is_path_within(path: Path, parent: Path) -> bool:
    comparable_path = _comparable_path(path)
    comparable_parent = _comparable_path(parent)
    try:
        return os.path.commonpath((comparable_path, comparable_parent)) == comparable_parent
    except ValueError:
        return False


def test_report_pytest_harness_state(pytestconfig):
    import config as app_config

    base_temp = Path(pytestconfig.option.basetemp).resolve()
    session_temp = Path(os.environ["TMP"]).resolve()
    appdata = Path(os.environ["MUSIC_APP_DATA_DIR"]).resolve()
    temp_environment = {
        key: str(Path(os.environ[key]).resolve())
        for key in ("TMP", "TEMP", "TMPDIR")
    }
    print(
        "PYTEST_HARNESS_PROBE="
        + json.dumps(
            {
                "basetemp": str(base_temp),
                "generated": bool(pytestconfig._album_haven_generated_basetemp),
                "basetemp_exists": base_temp.is_dir(),
                "session_temp": str(session_temp),
                "session_temp_exists": session_temp.is_dir(),
                "appdata": str(appdata),
                "appdata_exists": appdata.is_dir(),
                "appdata_is_session_owned": _is_path_within(appdata, base_temp),
                "config_data_dir_matches": Path(app_config.Config.DATA_DIR).resolve() == appdata,
                "temp_environment": temp_environment,
                "tempfile_tempdir": str(Path(tempfile.tempdir or "").resolve()),
                "owner_marker_exists": (base_temp / ".album-haven-pytest-owner.json").is_file(),
            },
            sort_keys=True,
        )
    )
