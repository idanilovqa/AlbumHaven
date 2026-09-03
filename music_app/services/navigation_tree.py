"""Server renderer for the shared flat NavigationTreeItem template."""
from pathlib import Path
import re

from markupsafe import Markup, escape

_ITEM_TEMPLATE = (Path(__file__).resolve().parent.parent / "templates" / "components" / "navigation-tree-item.html").read_text(encoding="utf-8")


def render_navigation_tree_item(*, label, href="#", key="", selected=False, icon="", count=None, variant="artists", attributes=None, action=False) -> Markup:
    settings = variant == "settings"
    legacy = "settings-nav-item" if settings else "artist-link"
    active_class = " is-active" if settings else " active"
    tag = "button" if action else "a"
    values = {
        "class": legacy + (active_class if selected else "") + " navigation-tree-item" + (" is-selected" if selected else ""),
        "data-navigation-tree-item": "settings" if settings else "artists",
        "data-navigation-tree-key": key,
    }
    if action:
        values["type"] = "submit"
    else:
        values["href"] = href if re.match(r"^(?:/(?!/)|#)", str(href)) else "#"
    for name, value in (attributes or {}).items():
        if re.fullmatch(r"data-[a-z0-9-]+", name) and not name.startswith("data-navigation-tree-"):
            values[name] = value
    if selected:
        values["aria-current"] = "page" if settings else "true"
    attrs = " ".join(f'{name}="{escape(value)}"' for name, value in values.items())
    icon_html = f'<span class="navigation-tree-icon" aria-hidden="true">{escape(icon)}</span>' if icon else ""
    count_html = "" if count is None else f'<span class="navigation-tree-count artist-count">{escape(count)}</span>'
    return Markup(_ITEM_TEMPLATE % (tag, attrs, icon_html, escape(label), count_html, tag))
