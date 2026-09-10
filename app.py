import os
import sys

from music_app import create_asgi_app

_ASGI_SERVER_VALUES = {"asgi", "fastapi", "uvicorn"}
_ASGI_APP_FACTORY_TARGET = "music_app:create_asgi_app"
_STD_INPUT_HANDLE = -10
_ENABLE_QUICK_EDIT_MODE = 0x0040
_ENABLE_EXTENDED_FLAGS = 0x0080
_INVALID_HANDLE_VALUE = -1


def _selected_server_kind() -> str:
    return str(os.getenv("MUSIC_APP_SERVER", "asgi")).strip().lower()


def _disable_windows_console_quick_edit_mode(
    *,
    platform_name: str = sys.platform,
    kernel32=None,
) -> bool:
    if platform_name != "win32":
        return False

    try:
        import ctypes

        console_api = kernel32 if kernel32 is not None else ctypes.windll.kernel32
        stdin_handle = console_api.GetStdHandle(_STD_INPUT_HANDLE)
        invalid_handles = {
            0,
            _INVALID_HANDLE_VALUE,
            ctypes.c_void_p(_INVALID_HANDLE_VALUE).value,
        }
        if stdin_handle in invalid_handles:
            return False

        current_mode = ctypes.c_uint32()
        if not console_api.GetConsoleMode(stdin_handle, ctypes.byref(current_mode)):
            return False

        live_mode = (
            current_mode.value | _ENABLE_EXTENDED_FLAGS
        ) & ~_ENABLE_QUICK_EDIT_MODE
        return bool(console_api.SetConsoleMode(stdin_handle, live_mode))
    except (AttributeError, OSError, TypeError, ValueError):
        return False


def _run_asgi_server(*, port: int, reload: bool) -> None:
    import uvicorn
    from config import Config
    from music_app.server_tls import local_https_options

    _disable_windows_console_quick_edit_mode()
    tls_options = local_https_options(os.environ, data_dir=Config.DATA_DIR, port=port)
    if tls_options:
        print(
            f"Album Haven local HTTPS: {os.environ['ALBUM_HAVEN_PUBLIC_BASE_URL'].rstrip('/')}/login\n"
            "A locally generated certificate is used. Your browser will show a certificate warning.",
            flush=True,
        )
    uvicorn.run(
        _ASGI_APP_FACTORY_TARGET,
        host=tls_options.pop("host", "0.0.0.0"),
        port=port,
        reload=reload,
        factory=True,
        **tls_options,
    )


app = create_asgi_app()

if __name__ == "__main__":
    reloader_enabled = str(os.getenv("MUSIC_APP_RELOADER", "")).strip().lower() in {"1", "true", "yes", "on"}
    app_port = int(str(os.getenv("MUSIC_APP_PORT", "5000")).strip() or "5000")
    server_kind = _selected_server_kind()
    if server_kind in _ASGI_SERVER_VALUES:
        _run_asgi_server(port=app_port, reload=reloader_enabled)
        raise SystemExit(0)

    raise SystemExit(f"Unsupported MUSIC_APP_SERVER={server_kind!r}; use 'asgi', 'fastapi', or 'uvicorn'.")
