"""Rendered shell contracts for the approved shared app bar extraction."""

from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from types import SimpleNamespace

from jinja2 import Environment, FileSystemLoader, select_autoescape
import pytest

from music_app.services.allowed_actions import AllowedActions
from music_app.services.capability_assignments import assignment_editor


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

    def render_template(name="index.html", *, administrator=True, extra_actions=(), **context):
        actions = AllowedActions((("accounts.read", "accounts.create") if administrator else ()) + tuple(extra_actions))
        initial_view = {
            "gallery_scope": "local",
            "gallery_display_mode": "rows",
            "selected_artist_family_display_mode": "flat",
            "gallery_scale_percent": 125,
            "visible_library_categories": ["albums", "singles"],
        }
        html = environment.get_template(name).render(
            request=SimpleNamespace(state=SimpleNamespace(capability_ui=None)),
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
            playback_allowed_actions=AllowedActions(()),
            account_menu_csrf_token="library-csrf",
            allowed_actions=actions,
            **({"csrf_token": "settings-csrf"} if name != "index.html" else {}),
            profile={"username": "Listener", "sessions": []},
            roster={"library_name": "Test library", "members": []},
            member=None,
            listener_defaults=[],
            capability_groups=[],
            access_editor=assignment_editor(None, []),
            **context,
        )
        return Document(html).root

    return render_template


def assert_home_brand(bar):
    links = [link for link in bar.find_all("a", href="/") if link.find_all("img")]
    assert len(links) == 1, "The app bar must contain one logo linking to the library"
    link = links[0]
    assert link.attrs.get("aria-label"), "The image-only home link needs an accessible name"
    assert link.one("img").attrs["src"].endswith("/album-haven-cloud-vinyl.png")


@pytest.mark.parametrize("template", ["index.html", "admin-members.html", "admin-account-detail.html", "admin-server.html", "account.html"])
def test_complete_document_account_menus_have_unique_ids_and_valid_logout_tokens(render, template):
    document = render(template)
    identifiers = [element.attrs["id"] for element in document.find_all(id=None)]
    assert len(identifiers) == len(set(identifiers)), "Hidden shell chrome must not duplicate document IDs"
    components = document.find_all(**{"data-account-menu-component": None})
    assert len(components) == (2 if template == "index.html" else 1)
    expected_token = "library-csrf" if template == "index.html" else "settings-csrf"
    for component in components:
        trigger = component.one("button", **{"data-account-menu-trigger": None})
        menu = component.one("div", **{"data-account-menu": None})
        assert trigger.attrs["aria-controls"] == menu.attrs["id"]
        assert document.one(id=trigger.attrs["aria-controls"]) is menu
        logout = menu.one("form", action="/logout")
        assert logout.one("input", name="csrf_token").attrs["value"] == expected_token
    if template == "index.html":
        document.one("button", id="settings-button")


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


def test_library_app_bar_owns_sources_and_aligns_search_with_gallery_body(render):
    document = render()
    shell = document.one(id="app-shell")
    bar = shell.one(**{"data-shell-slot": "app_bar"})
    form = bar.one("form", id="search-form")
    gallery = shell.one(id="albums-viewport")
    assert form.attrs["data-shell-horizontal-align"] == "gallery-body"
    assert gallery.attrs["data-shell-horizontal-align"] == "gallery-body"

    sources = bar.one("button", **{"data-gallery-sources-anchor": "1"})
    assert sources.attrs["aria-label"] == "Sources"
    assert "aria-haspopup" not in sources.attrs
    assert sources.attrs["aria-expanded"] == "false"
    menu_id = sources.attrs["aria-controls"]
    menu = bar.one(id=menu_id)
    assert menu.attrs["data-anchored-surface"] == "sources"
    assert menu.attrs["role"] == "group"
    assert menu.attrs["aria-label"] == "Sources"
    switches = menu.find_all(**{"role": "switch"})
    assert [switch.attrs["data-gallery-source"] for switch in switches] == [
        "main_library", "new_arrivals", "hoard",
    ]
    assert not any("Open New Arrivals" in switch.text for switch in menu.find_all())


def test_loose_tracks_is_a_side_panel_mode_with_its_own_collections_tree(render):
    shell = render().one(id="app-shell")
    toolbar = render().one(**{"class": "toolbar-right"})
    assert toolbar.find_all(**{"data-open-non-album-tracks": None}) == []
    modes = shell.one(**{"class": "mobile-artists-mode"}).find_all(**{"data-navigation-mode": None})
    assert [mode.attrs["data-navigation-mode"] for mode in modes] == ["artists", "collections"]
    assert [mode.attrs["aria-pressed"] for mode in modes] == ["true", "false"]
    artists = shell.one(id="sidebar-list")
    assert artists.find_all(**{"data-open-non-album-tracks": None}) == []
    collections = shell.one(id="sidebar-collections")
    assert collections.attrs["data-navigation-tree"] == "collections"
    assert collections.attrs["aria-label"] == "Custom Collections"
    assert "hidden" in collections.attrs
    item = collections.one(**{"data-navigation-tree-key": "collection:loose-tracks"})
    assert item.attrs["data-library-wide"] == "1"
    compact = shell.one(id="shell-navigation-compact")
    buttons = compact.find_all("button")
    assert buttons[0].attrs["id"] == "artist-tree-navigation-button"
    assert buttons[1].attrs["data-open-non-album-tracks"] == "1"
    assert "disabled" not in buttons[1].attrs


def test_gallery_template_hosts_exact_controls_and_album_type_defaults(render):
    shell = render().one(id="app-shell")
    gallery_bar = shell.one(**{"data-gallery-bar-instance": "gallery"})
    actions = gallery_bar.find_all("button", **{"data-gallery-bar-action": None})
    assert [action.attrs["data-gallery-bar-action"] for action in actions] == [
        "artist-family", "view", "album-types",
    ]
    assert "aria-haspopup" not in actions[-1].attrs
    album_types = shell.one(**{"data-anchored-surface": "album-types"})
    assert album_types.attrs["role"] == "group"
    assert album_types.attrs["aria-label"] == "Album types"
    choices = album_types.find_all("button", **{"data-gallery-album-type": None})
    assert [choice.attrs["data-gallery-album-type"] for choice in choices] == [
        "studio", "ep", "live", "demo", "compilation", "single",
    ]
    selected = [choice.attrs["data-gallery-album-type"] for choice in choices if choice.attrs.get("aria-pressed") == "true"]
    assert selected == ["studio", "ep", "compilation"]
    choices_by_type = {choice.attrs["data-gallery-album-type"]: choice for choice in choices}
    for release_type in ("studio", "ep", "live", "demo", "compilation", "single"):
        assert "disabled" in choices_by_type[release_type].attrs
        assert choices_by_type[release_type].attrs["aria-disabled"] == "true"
    split_albums = album_types.one("button", **{"data-gallery-split-albums": "1"})
    assert "gallery-switch--tri" in split_albums.attrs["class"]
    assert split_albums.attrs["role"] == "slider"
    assert split_albums.attrs["aria-valuenow"] == "2"
    assert split_albums.attrs["aria-valuetext"] == "Show Split Albums"
    album_types.one("button", **{"data-open-non-album-tracks": "1"})
    customize = album_types.one("button", **{"data-gallery-customize-preview": "1"})
    assert "disabled" in customize.attrs or customize.attrs.get("aria-disabled") == "true"


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
    hover_icon = notifications.one("img", **{"class": "cover-lookup-drawer-glyph-hover"})
    assert "src" not in hover_icon.attrs
    assert hover_icon.attrs["data-src"].endswith("/static/images/cover-lookup-notification-icon.png")
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


def test_admin_members_shared_gallery_bar_renders_its_add_user_action(render):
    bar = render("admin-members.html").one(**{"data-gallery-bar-instance": "page"})
    add_user = bar.one("a", href="/admin/accounts/new")
    assert add_user.one("span", **{"class": "ui-button__content"}).text.strip() == "Add user"


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


def test_search_component_appends_custom_actions_and_supports_multiple_instances(render_search_component):
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
    assert len(document.find_all("button")) == 5
    submits = document.find_all("button", **{"data-search-submit": None})
    assert [button.attrs["aria-label"] for button in submits] == ["Search", "Find tracks"]
    clears = document.find_all("button", **{"data-search-clear": None})
    assert len(clears) == 2
    assert all("hidden" in button.attrs and button.attrs["aria-label"] == "Clear search" for button in clears)
    assert len(submits) == 2
    assert custom.parent.children[-1] is custom
    second_field = document.one("input", id="second-search")
    assert second_field.parent.one("button", type="submit").attrs["aria-label"] == "Find tracks"


@pytest.mark.parametrize("template", ["admin-members.html", "admin-account-detail.html", "admin-server.html", "account.html"])
def test_standalone_app_bar_keeps_settings_and_logout(render, template):
    document = render(template)
    menu = document.one("div", **{"data-account-menu": None})
    assert menu.one("a", **{"data-account-menu-settings": None}).attrs["href"] == "/?settings=appearance"
    assert not menu.find_all(**{"data-account-menu-admin": None})
    assert menu.one("form").attrs["action"] == "/logout"
    assert menu.one("input", name="csrf_token").attrs["value"] == "settings-csrf"


@pytest.mark.parametrize(
    ("template", "section"),
    [("admin-members.html", "users"), ("admin-account-detail.html", "users"), ("admin-server.html", "server"), ("account.html", "account")],
)
def test_settings_navigation_selects_only_the_current_page(render, template, section):
    document = render(template, extra_actions=("system.preview_storage.read",))
    selected = [item.attrs["data-settings-section"] for item in document.find_all(**{"data-settings-section": None}) if item.attrs.get("aria-current") == "page"]
    assert selected == [section]


@pytest.mark.parametrize("template", ["admin-members.html", "admin-server.html", "account.html"])
def test_settings_pages_share_the_gallery_header_geometry_without_desktop_library_back(render, template):
    document = render(template, extra_actions=("system.preview_storage.read",))
    owners = [section for section in document.find_all("section") if "settings-main" in (section.attrs.get("class") or "").split()]
    assert len(owners) == 1, "Every Settings page uses the shared settings-main surface"
    header = owners[0].one("header", **{"data-gallery-bar-instance": "page"})
    back = header.one("a", **{"data-settings-parent": None})
    assert "page-gallery-bar__back--narrow-only" in back.attrs["class"].split()


def test_account_detail_keeps_its_desktop_back_to_users(render):
    header = render("admin-account-detail.html").one("header", **{"data-gallery-bar-instance": "page"})
    back = header.one("a", **{"data-settings-parent": None})
    assert back.attrs["href"] == "/admin/members"
    assert "page-gallery-bar__back--narrow-only" not in back.attrs["class"].split()


def test_server_settings_compose_shared_radio_path_and_button_components(render):
    document = render("admin-server.html", extra_actions=("system.preview_storage.read",), can_browse_server_folders=True)
    form = document.one("form", **{"data-admin-server": None})
    radios = form.find_all("input", type="radio")
    assert [radio.parent.attrs["class"] for radio in radios] == ["ui-radio-option", "ui-radio-option"]
    assert [radio.parent.one("span").text.strip() for radio in radios] == ["Album folders", "Special path"]
    path_input = form.one("input", **{"data-preview-path": None})
    assert path_input.parent.attrs["class"] == "ui-path-input ui-input-action"
    browse = path_input.parent.one("button", **{"data-path-input-browse": None})
    assert "action-button" in browse.attrs["class"].split()
    assert "disabled" in path_input.attrs and "disabled" in browse.attrs, "The path stays disabled until Special path is chosen"
    assert "data-path-input-browsable" in browse.attrs, "Browse permission survives the initial disabled state"
    plain = render("admin-server.html", extra_actions=("system.preview_storage.read",), can_browse_server_folders=False)
    assert "data-path-input-browsable" not in plain.one("button", **{"data-path-input-browse": None}).attrs
    save = form.one("button", **{"data-preview-save": None})
    assert {"ui-button", "ui-button--primary"} <= set(save.attrs["class"].split())
    assert "disabled" in save.attrs
    # Owner (11-10): "I clicked Retry failed files - but saw no reaction". The alerts kept no hook, so every message
    # was dropped; they carry their data attributes and sit right before the buttons that cause them.
    status = form.one("section", **{"data-preview-status": None})
    error = form.one("section", **{"data-preview-error": None})
    assert (status.attrs["role"], error.attrs["role"]) == ("status", "alert")
    siblings = status.parent.children
    actions = next(child for child in siblings if child.find_all("button", **{"data-preview-retry": None}))
    assert siblings.index(status) < siblings.index(error) < siblings.index(actions)
    assert not form.find_all("progress"), "Relocation uses concise text, not a progress bar"
    assert "Loading" not in form.text
    assert len(document.find_all(id="app-form-modal")) == 1, "The folder picker dialog is available on direct loads"


def test_page_header_hamburger_buttons_have_no_outline(render):
    # Owner (11-09): "loose outline on this hamburger button everywhere it is used" - the Settings sections and
    # library navigation hamburgers are bare, like Back and the admin Account navigation hamburger.
    document = render()
    for button_id in ("mobile-settings-button", "mobile-library-button"):
        classes = document.one(id=button_id).attrs["class"].split()
        assert "action-button--bare" in classes, button_id
