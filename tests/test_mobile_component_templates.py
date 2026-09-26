"""Render shared templates without an application/database shortcut."""
from pathlib import Path
from types import SimpleNamespace
from jinja2 import Environment, FileSystemLoader, select_autoescape

ROOT = Path(__file__).resolve().parents[1]


def templates():
    return Environment(loader=FileSystemLoader(ROOT / 'music_app/templates'), autoescape=select_autoescape())


def test_non_admin_menu_exposes_password_account_without_admin_link():
    html = templates().get_template('partials/account-menu.html').render(
        account_menu_allowed_actions=SimpleNamespace(allows=lambda _: False), account_menu_csrf_token='test-csrf')
    assert 'My Account' in html and 'href="/account"' in html
    assert 'data-account-menu-admin' not in html
    assert 'action="/logout"' in html


def test_owner_menu_keeps_admin_entry_instead_of_duplicate_account_item():
    html = templates().get_template('partials/account-menu.html').render(
        account_menu_allowed_actions=SimpleNamespace(allows=lambda action: action == 'accounts.read'), account_menu_csrf_token='test-csrf')
    assert 'Admin Panel' in html
    assert 'data-account-menu-profile' not in html


def test_shared_password_header_has_gallery_bar_and_accessible_navigation():
    html = templates().from_string('{% from "partials/page-gallery-bar.html" import page_gallery_bar %}{{ page_gallery_bar("Password", "Rendref", settings_navigation=true) }}').render()
    assert 'data-gallery-bar' in html
    assert '>Password</h1>' in html and 'Rendref' in html
    assert 'data-settings-nav-toggle' in html
    assert 'Back to library' in html


def test_all_changed_templates_parse():
    for name in ['index.html', 'account.html', 'admin-members.html', 'admin-account-detail.html',
                 'partials/admin-settings-nav.html', 'partials/overlay-shells.html']:
        templates().get_template(name)
