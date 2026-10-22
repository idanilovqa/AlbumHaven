"""Static delivery with deterministic native JavaScript module MIME."""
from pathlib import Path

from starlette.staticfiles import StaticFiles


class NativeModuleStaticFiles(StaticFiles):
    def file_response(self, full_path, stat_result, scope, status_code=200):
        # Keep Starlette's confined lookup, validators, HEAD and range handling.
        response = super().file_response(full_path, stat_result, scope, status_code)
        if response.status_code in (200, 206) and Path(full_path).suffix.lower() == ".mjs":
            # Host MIME databases may omit or misclassify this extension.
            response.headers["Content-Type"] = "text/javascript; charset=utf-8"
        return response
