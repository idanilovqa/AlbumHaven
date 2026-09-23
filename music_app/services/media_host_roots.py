"""Immutable media-host request scope and bounded directory enumeration."""
from pathlib import Path
from fastapi import HTTPException


async def root_request_scope(request):
    from music_app.services.current_actor_asgi import current_actor_from_request
    actor = await current_actor_from_request(request)
    library = actor.current_library_id
    host = getattr(request.app.state, "media_host_library_id", None)
    if (not actor.is_authenticated or actor.account_id is None
            or type(library) is not int or library <= 0
            or not any(item.library_id == library for item in actor.library_relationships)
            or type(host) is not int or library != host):
        raise HTTPException(403, "Current library is not the configured media host")
    return {"library_id": library, "media_host_library_id": host}


def bounded_directories(config, path):
    raw_bases = config.get("ALBUM_HAVEN_LIBRARY_BROWSE_BASES")
    if not isinstance(raw_bases, list) or not raw_bases or any(not isinstance(base, str) or not base.strip() for base in raw_bases):
        raise HTTPException(403, "Directory browsing is not configured")
    try:
        bases = tuple(Path(base).resolve(strict=True) for base in raw_bases)
        if not all(base.is_dir() for base in bases):
            raise ValueError()
        if not path:
            return {"path": "", "parent_path": None, "entries": [{"name": base.name, "path": str(base)} for base in bases]}
        target = Path(path).resolve(strict=True)
        if not any(target == base or target.is_relative_to(base) for base in bases):
            raise HTTPException(403, "Directory is outside configured browse bases")
        if not target.is_dir():
            raise ValueError()
        children = []
        for child in target.iterdir():
            resolved = child.resolve(strict=True)
            if resolved.is_dir() and any(resolved == base or resolved.is_relative_to(base) for base in bases):
                children.append({"name": child.name, "path": str(resolved)})
                if len(children) > 500:
                    raise HTTPException(409, "Directory has too many children; choose a narrower path")
        return {"path": str(target), "parent_path": str(target.parent) if any(target.parent == base or target.parent.is_relative_to(base) for base in bases) else None, "entries": sorted(children, key=lambda child: child["name"].casefold())}
    except (OSError, ValueError):
        raise HTTPException(400, "Directory is unavailable") from None
