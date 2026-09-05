"""Rendered shell contracts for the approved shared app bar extraction."""

from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
import pytest

from music_app.services.allowed_actions import AllowedActions


@dataclass(eq=False)
class Element:
    tag: str
    attrs: dict[str, str | None]
    parent: "Element | None" = None
    children: list["Element"] = field(default_factory=list)
    text: str = ""

    def find_all(self, tag=None, **attrs):
        found = []
        for child in self.children:
            if (tag is None or child.tag == tag) and all(
                key in child.attrs and (value is None or child.attrs[key] == value)
                for key, value in attrs.items()
            ):
                found.append(child)
            found.extend(child.find_all(tag, **attrs))
        return found

    def one(self, tag=None, **attrs):
        found = self.find_all(tag, **attrs)
        assert len(found) == 1, f"Expected one {tag or 'element'} matching {attrs}, found {len(found)}"
        return found[0]


class Document(HTMLParser):
    VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self, html):
        super().__init__()
        self.root = Element("document", {})
        self.current = self.root
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        element = Element(tag, dict(attrs), self.current)
        self.current.children.append(element)
        if tag not in self.VOID_TAGS:
            self.current = element

    def handle_endtag(self, tag):
        current = self.current
        while current.parent is not None:
            if current.tag == tag:
                self.current = current.parent
                return
            current = current.parent

    def handle_data(self, data):
        self.current.text += data


@pytest.fixture
def render():
    templates = Path(__file__).resolve().parents[2] / "music_app" / "templates"
    environment = Environment(loader=FileSystemLoader(templates), autoescape=select_autoescape())

    def render_template(name="index.html", *, administrator=True):
        actions = AllowedActions(("accounts.read",) if administrator else ())
        initial_view = {
            "gallery_scope": "local",
            "gallery_display_mode": "rows",
            "selected_artist_family_display_mode": "flat",
            "gallery_scale_percent": 125,
            "visible_library_categories": ["albums", "singles"],
        }
        html = environment.get_template(name).render(
            url_for=lambda endpoint, **kwargs: "/static/" + kwargs["filename"],
            app_name="Album Haven",
            app_version="test",
            runtime_asset_version="test",
            bootstrap_payload={"initial_view": initial_view},
            startup_preview={"mode": "empty_shell", "sidebar_html": "", "gallery_html": ""},
            query="Dream & Day",
            effective_selected_artist="Artist & Friends",
            selected_artist="Artist & Friends",
            account_menu_allowed_actions=actions,
            account_menu_csrf_token="library-csrf",
            allowed_actions=actions,
            csrf_token="settings-csrf",
            profile={"username": "Listener", "sessions": []},
            roster={"library_name": "Test library", "members": []},
            member=None,
            listener_defaults=[],
            capability_groups=[],
        )
        return Document(html).root

    return render_template


def assert_home_brand(bar):
    links = [link for link in bar.find_all("a", href="/") if link.find_all("img")]
    assert len(links) == 1, "The app bar must contain one logo linking to the library"
    link = links[0]
    assert link.attrs.get("aria-label"), "The image-only home link needs an accessible name"
    assert link.one("img").attrs["src"].endswith("/album-haven-cloud-vinyl.png")


def test_library_app_bar_is_above_both_sidebar_and_main_content(render):
    document = render()
    shell = document.one(id="app-shell")
    bar = shell.one(**{"data-shell-slot": "app_bar"})
    sidebar = shell.one(id="shell-navigation-rail")
    content = shell.one(id="shell-main-surface")
    assert bar.parent is shell, "The full-width bar must be outside the scrolling main content"
    assert shell.children.index(bar) < shell.children.index(sidebar)
    assert shell.children.index(bar) < shell.children.index(content)
    assert_home_brand(bar)


def test_library_search_preserves_selected_scope_and_repeated_categories(render):
    bar = render().one(id="app-shell").one(**{"data-shell-slot": "app_bar"})
    form = bar.one("form", id="search-form")
    assert form.attrs["action"] == "/"
    assert form.attrs["method"].lower() == "get"
    assert form.one("input", name="q").attrs["value"] == "Dream & Day"
    fields = [(element.attrs["name"], element.attrs["value"]) for element in form.find_all("input", type="hidden")]
    assert fields == [
        ("artist", "Artist & Friends"),
        ("gallery_scope", "local"),
        ("gallery_display", "rows"),
        ("family_display", "flat"),
        ("gallery_scale_percent", "125"),
        ("category", "albums"),
        ("category", "singles"),
    ]
    assert form.one("button", type="submit").attrs["aria-label"] == "Search"


@pytest.mark.parametrize("administrator", [False, True])
def test_library_actions_retain_handlers_and_server_filtered_admin_entry(render, administrator):
    bar = render(administrator=administrator).one(id="app-shell").one(**{"data-shell-slot": "app_bar"})
    controls = bar.find_all("button")
    notifications = bar.one("button", id="cover-lookup-drawer-button")
    status = bar.one("button", id="scan-indicator")
    settings = bar.one("button", id="settings-button")
    for action in (notifications, status, settings):
        classes = (action.attrs.get("class") or "").split()
        assert "action-button" in classes
        assert "ui-button--icon" in classes
        assert "ui-button--medium" in classes
    assert notifications.attrs["data-toggle-cover-lookup-drawer"] == "1"
    assert status.attrs["aria-label"] == "Library status"
    assert "data-account-menu-trigger" in settings.attrs
    assert controls.index(notifications) < controls.index(status) < controls.index(settings)
    assert len(bar.find_all("a", href="/admin/members")) == int(administrator)
    logout = bar.one("form", action="/logout")
    assert logout.attrs["method"].lower() == "post"
    assert logout.one("input", name="csrf_token").attrs["value"] == "library-csrf"


@pytest.mark.parametrize("template", ["index.html", "admin-members.html", "account.html", "admin-account-detail.html"])
def test_settings_shell_owns_bar_above_navigation_with_no_duplicate_sidebar_brand(render, template):
    document = render(template)
    host = document.one(**{"data-settings-host": None})
    bar = host.one(**{"data-shell-slot": "app_bar"})
    navigation = host.one(**{"data-settings-nav": None})
    outlet = host.one(**{"data-settings-outlet": None})
    assert bar.parent is host
    assert host.children.index(bar) < host.children.index(navigation)
    assert host.children.index(bar) < host.children.index(outlet)
    assert_home_brand(bar)
    assert not navigation.find_all("img"), "Settings must not repeat the logo in its sidebar"
    assert not bar.find_all("form", id="search-form"), "Settings leaves optional library search empty"
    assert ("hidden" in host.attrs) == (template == "index.html")


def test_hosted_settings_keeps_bottom_player_outside_both_switchable_shells(render):
    document = render()
    shell = document.one(id="app-shell")
    host = document.one(**{"data-settings-host": None})
    player = document.one(**{"data-shell-slot": "bottom_player"})
    assert player.parent is shell.parent is host.parent
    assert not shell.find_all(id="player-play")
    assert not host.find_all(id="player-play")
    player.one("button", id="player-play")


def test_mobile_artist_drawer_has_a_reachable_existing_action_outside_the_drawer(render):
    shell = render().one(id="app-shell")
    trigger = shell.one("button", id="artists-drawer-button")
    assert trigger.attrs["data-toggle-artists-drawer"] == "1"
    assert trigger.attrs.get("aria-label") or trigger.text.strip()
    assert trigger.attrs["aria-controls"] == "shell-navigation-rail"
    assert trigger.attrs["aria-expanded"] == "false"
    assert "disabled" not in trigger.attrs
    assert not shell.one(id="shell-navigation-rail").find_all(id="artists-drawer-button")


@pytest.fixture
def render_search_component():
    templates = Path(__file__).resolve().parents[2] / "music_app" / "templates"
    environment = Environment(loader=FileSystemLoader(templates), autoescape=select_autoescape())

    def render_component(source, **context):
        return Document(environment.from_string(
            '{% from "partials/search-input.html" import search_input %}' + source
        ).render(**context)).root

    return render_component


def test_search_component_defaults_to_an_accessible_embedded_submit_action(render_search_component):
    document = render_search_component(
        '{{ search_input("catalog-search", value=query, suggestions_id="catalog-suggestions") }}',
        query='Music & "More"',
    )
    field = document.one("input", id="catalog-search")
    button = document.one("button", type="submit")
    assert field.attrs["value"] == 'Music & "More"'
    assert field.attrs["name"] == "q"
    assert field.attrs["aria-controls"] == "catalog-suggestions"
    assert field.attrs["role"] == "combobox"
    assert button.attrs["aria-label"] == "Search"
    assert button.parent.parent is field.parent
    assert button.one("svg").attrs["aria-hidden"] == "true"
    assert "hidden" in document.one(id="catalog-suggestions").attrs


def test_search_component_allows_a_complete_button_override_and_multiple_instances(render_search_component):
    document = render_search_component('''
        {% call(action_class) search_input("filter-search", name="filter", label="Filter albums") %}
          <button class="{{ action_class }}" type="button" aria-label="Filter" data-filter="albums">Go</button>
        {% endcall %}
        {{ search_input("second-search", button_label="Find tracks") }}
    ''')
    field = document.one("input", id="filter-search")
    custom = document.one("button", **{"aria-label": "Filter"})
    assert field.attrs["name"] == "filter"
    assert field.attrs["aria-label"] == "Filter albums"
    assert "role" not in field.attrs
    assert "aria-controls" not in field.attrs
    assert custom.attrs["type"] == "button"
    assert custom.attrs["data-filter"] == "albums"
    assert custom.parent.parent is field.parent
    assert not custom.find_all("svg")
    assert len(document.find_all("button")) == 2
    assert document.one("button", type="submit").attrs["aria-label"] == "Find tracks"
